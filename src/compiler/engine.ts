import type { DagNode, Json } from '../graph.js'
import type { NodeResult } from '../scheduler.js'
import { parsePlan, type PlanTask } from './plan.js'
import { joinerPrompt, parseJoiner, plannerSystemPrompt, plannerRequest,
  type PlannerPromptOptions, type PlannerRequest } from './prompts.js'

export type CompileStatus = 'finished' | 'exhausted' | 'budget' | 'empty-plan'

export interface RoundRecord {
  round: number
  /** Raw planner text, kept for trace and for the next replan. */
  plan: string
  taskCount: number
  decision: 'finish' | 'replan' | 'gated-replan' | 'empty' | 'unknown'
  detail: string
  tokens: number
  statuses: Record<string, number>
}

export interface CompileResult {
  status: CompileStatus
  summary: string
  rounds: RoundRecord[]
  tokens: number
}

export interface CompilerCallbacks {
  /** One planner completion. `tokens` is whatever the provider reports. */
  plan(request: PlannerRequest, context: { round: number; replan: boolean }): Promise<{ text: string; tokens?: number }>
  /** One joiner completion. */
  join(prompt: string, context: { round: number }): Promise<{ text: string; tokens?: number }>
  /** Execute one round's graph; the existing scheduler is the intended implementation. */
  execute(nodes: DagNode[], context: { round: number }): Promise<NodeResult[]>
  /** Map positional plan tasks onto tool arguments. */
  toNodes(tasks: PlanTask[], context: { round: number }): DagNode[]
  /** Optional working-tree probe used by the net-diff gate. */
  workingTreeChanged?(): Promise<boolean>
  trace?(event: string, data: Record<string, unknown>): void
}

export interface CompilerOptions {
  question: string
  knownTools: ReadonlySet<string>
  plannerTools: PlannerPromptOptions['tools']
  guidelines?: readonly string[]
  failurePolicy?: 'continue' | 'stop'
  /** Hard cap on rounds, independent of the token budget. Defaults to 12. */
  maxRounds?: number
  /** Planner + joiner tokens allowed for the whole turn. Defaults to 120_000. */
  tokenBudget?: number
  /** Tasks parsed per round. Defaults to 32. */
  maxTasksPerRound?: number
  /**
   * Earlier rounds kept verbatim in the replan context. Older rounds collapse into a
   * one-line note so the planner prompt cannot grow without bound.
   */
  keepRecentRounds?: number
  /** Guardrails applied after a `Finish`. */
  gates?: { netDiff?: boolean }
}

const DEFAULTS = {
  maxRounds: 12,
  tokenBudget: 120_000,
  maxTasksPerRound: 32,
  keepRecentRounds: 2,
} as const

/**
 * Round loop for compile-style orchestration: plan -> dispatch -> join -> replan.
 *
 * The loop owns budgeting and termination only. Planning, execution and evaluation are
 * injected, so the same engine can be driven by a tool, by the `llm/stream` waterfall,
 * or by a test double.
 */
export async function compile(
  options: CompilerOptions,
  callbacks: CompilerCallbacks,
): Promise<CompileResult> {
  const maxRounds = options.maxRounds ?? DEFAULTS.maxRounds
  const tokenBudget = options.tokenBudget ?? DEFAULTS.tokenBudget
  const maxTasks = options.maxTasksPerRound ?? DEFAULTS.maxTasksPerRound
  const keepRecent = options.keepRecentRounds ?? DEFAULTS.keepRecentRounds
  const netDiff = options.gates?.netDiff ?? true
  const system = plannerSystemPrompt({
    tools: options.plannerTools,
    guidelines: options.guidelines,
  })

  const rounds: RoundRecord[] = []
  const history: string[] = []
  let tokens = 0
  let emptyStreak = 0
  let summary = ''

  for (let round = 1; round <= maxRounds; round += 1) {
    if (tokens >= tokenBudget) {
      callbacks.trace?.('run-end', { status: 'budget', round, tokens })
      return { status: 'budget', summary: 'token budget exhausted', rounds, tokens }
    }
    const replan = round > 1
    const request = replan
      ? plannerRequest(options.question, compact(history, keepRecent), true)
      : { system: '', user: `Question: ${options.question}` }
    const planned = await callbacks.plan({ ...request, system }, { round, replan })
    tokens += planned.tokens ?? 0
    callbacks.trace?.('plan', { round, replan, chars: planned.text.length })

    const parsed = parsePlan(planned.text, { knownTools: options.knownTools, maxTasks })
    if (parsed.empty) {
      emptyStreak += 1
      rounds.push({ round, plan: planned.text, taskCount: 0, decision: 'empty',
        detail: 'no executable task parsed', tokens: planned.tokens ?? 0, statuses: {} })
      if (emptyStreak >= 2) {
        callbacks.trace?.('run-end', { status: 'empty-plan', round })
        return { status: 'empty-plan', summary: 'two consecutive empty plans', rounds, tokens }
      }
      history.push(`Previous Plan:\n\n(no executable task parsed)\n\n`)
      continue
    }
    emptyStreak = 0

    const nodes = callbacks.toNodes(parsed.tasks, { round })
    const results = await callbacks.execute(nodes, { round })
    const byId = new Map(results.map(result => [result.id, result]))
    const scratchpad = renderScratchpad(parsed.tasks, byId)

    const joined = await callbacks.join(joinerPrompt(options.question, scratchpad), { round })
    let roundTokens = (planned.tokens ?? 0) + (joined.tokens ?? 0)
    tokens += joined.tokens ?? 0
    let decision = parseJoiner(joined.text)
    if (decision.kind === 'unknown') {
      const retry = await callbacks.join(joinerPrompt(options.question, scratchpad), { round })
      tokens += retry.tokens ?? 0
      roundTokens += retry.tokens ?? 0
      decision = parseJoiner(retry.text)
    }

    const statuses = tally(results)
    if (decision.kind === 'finish') {
      if (netDiff && callbacks.workingTreeChanged) {
        const changed = await callbacks.workingTreeChanged()
        if (!changed) {
          rounds.push({ round, plan: planned.text, taskCount: parsed.tasks.length,
            decision: 'gated-replan', detail: 'finish rejected: working tree unchanged',
            tokens: roundTokens, statuses })
          history.push(`Previous Plan:\n\n${scratchpad}\n\nThought: ${decision.thought}\n\n`)
          continue
        }
      }
      summary = decision.summary
      rounds.push({ round, plan: planned.text, taskCount: parsed.tasks.length,
        decision: 'finish', detail: decision.summary, tokens: roundTokens, statuses })
      callbacks.trace?.('run-end', { status: 'finished', round, tokens })
      return { status: 'finished', summary, rounds, tokens }
    }

    const reason = decision.kind === 'replan' ? decision.reason : 'joiner produced no decision'
    const thought = decision.kind === 'unknown' ? '' : decision.thought
    rounds.push({ round, plan: planned.text, taskCount: parsed.tasks.length,
      decision: decision.kind === 'replan' ? 'replan' : 'unknown', detail: reason,
      tokens: roundTokens, statuses })
    history.push(`Previous Plan:\n\n${scratchpad}\n\nThought: ${thought}\n\n`)
  }

  callbacks.trace?.('run-end', { status: 'exhausted', round: maxRounds, tokens })
  return { status: 'exhausted', summary: summary || 'round budget exhausted', rounds, tokens }
}

function tally(results: readonly NodeResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
  return counts
}

function renderScratchpad(tasks: readonly PlanTask[], byId: ReadonlyMap<string, NodeResult>): string {
  return tasks.map(task => {
    const result = byId.get(task.id)
    const observation = result
      ? result.status === 'succeeded'
        ? (result.output ?? '')
        : `[${result.status}] ${result.error ?? 'no output'}`
      : '[not executed]'
    return `Thought: ${task.thought}\n${task.tool}(${task.args.map(renderArgument).join(', ')})\nObservation: ${observation}\n`
  }).join('')
}

/** Render one plan argument for the scratchpad without losing structure. */
function renderArgument(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Keep the most recent rounds verbatim; collapse the rest into a single note. */
function compact(history: readonly string[], keepRecent: number): string {
  if (history.length <= keepRecent) return history.join('')
  const dropped = history.length - keepRecent
  return `Earlier rounds: ${dropped} round(s) executed and omitted from this context.\n\n`
    + history.slice(-keepRecent).join('')
}

/** Bind single-argument plans onto one named tool parameter; used when no richer binder exists. */
export function positionalNodes(primaryParam: string): (tasks: PlanTask[]) => DagNode[] {
  return (tasks) => tasks.map(task => {
    if (task.args.length > 1) {
      throw new Error(`Task ${task.id}: supply a custom binder for multi-argument tools.`)
    }
    const value = task.args.length === 1 ? task.args[0]! : null
    const args: Record<string, Json> = value === null ? {} : { [primaryParam]: value }
    return { id: task.id, tool: task.tool, arguments: args, dependsOn: [...task.dependsOn] }
  })
}
