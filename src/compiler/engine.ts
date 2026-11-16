/**
 * The LLMCompiler engine: planner, task fetching unit, executor, and joiner.
 *
 * Port of the dsh ParallelQA demo engine (`dsh-demo/engine.mjs`), which is in
 * turn a port of `third_party/LLMCompiler` — one planner call compiles the
 * question into a task DAG, the task fetching unit dispatches ready waves with
 * `$id` substitution, tools run through the harness registry, and one joiner
 * call finishes or asks for a replan.
 *
 * Runtime access is injected, so the engine runs unchanged under the
 * `llm/stream` interposer (this package's `dag-compiler` plugin) and under a
 * tool body or a test harness.
 */

import { appendFileSync } from 'node:fs'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { toolSpecsOf, type CompilerToolConfig } from './config.js'
import { JOINER_PROMPT, plannerSystemPrompt, type ToolSpec } from './prompts.js'
import {
  parseJoinerOutput, parsePlan, scheduleWaves, stringifyArgs, substitute,
  type JoinerOutput, type PlanArgument, type PlanTask,
} from './plan.js'

/** One auxiliary call's route and bounds. */
interface CallOptions {
  system?: string
  user: string
  signal: AbortSignal
}

/** One auxiliary call's outcome. */
interface CallResult {
  text: string
  ms: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  stopReason?: string
}

/** Everything the engine needs from the host. */
export interface CompilerDeps {
  /** One streaming model call, routed exactly like any other harness call. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /** Dispatch one tool through the harness registry. */
  execute(input: {
    callId: ToolCallId
    name: string
    arguments: unknown
    signal: AbortSignal
    agent?: Agent
  }): Promise<ToolExecutionResult>
  /** Live agent owning the intercepted loop request, when the host resolves one. */
  agent?: Agent
  /** Structured scheduling record; the plugin forwards it to the host logger. */
  trace?(event: string, data: Record<string, unknown>): void
}

/** Engine settings resolved from plugin config. */
export interface CompilerSettings {
  provider: string
  model: string
  reasoningEffort?: string
  temperature: number
  maxTokens: number
  maxReplans: number
  maxParallel: number
  maxToolOutputChars: number
  tools: CompilerToolConfig[]
  plannerPrompt?: string
  joinerPrompt?: string
  metricsPath?: string
  callIdPrefix: string
}

/** One executed task, as reported after the run. */
export interface ExecutedTask {
  id: number
  tool: string
  args: PlanArgument[]
  resolvedArgs: PlanArgument[]
  deps: number[]
  ms: number
  observation: string
  truncated: boolean
}

/** Measurements for one compiled turn. */
export interface CompilerMetrics {
  plannerMs: number
  executeMs: number
  joinerMs: number
  llmCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  planTasks: number
  planWaves: number
  maxWidth: number
  replans: number
  plans: { question: string, round: number, plan: string, tasks: { id: number, tool: string, args: PlanArgument[], deps: number[] }[] }[]
  tasks: ExecutedTask[]
  /** Strict joiner answer — the model-facing answer, exactly as parsed. */
  answer: string
  /** Loosely parsed answer: what a caller may prefer when `answer` is empty. */
  answerTolerant: string
  joinerRaw: string
}

/** A failed auxiliary model call, carrying the model's failure code. */
export class CompilerLlmError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'CompilerLlmError'
    this.code = code
  }
}

/**
 * One auxiliary model call, collecting text deltas.
 * @param deps - host runtime.
 * @param settings - route and bounds.
 * @param options - prompts and cancellation for this call.
 * @returns the text, token usage, and wall-clock duration.
 */
export async function callModel(
  deps: CompilerDeps, settings: CompilerSettings, options: CallOptions,
): Promise<CallResult> {
  const started = Date.now()
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let reason: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  const chunks = deps.stream({
    provider: settings.provider,
    model: settings.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort as NonNullable<GenerateOptions['reasoningEffort']> }),
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    signal: options.signal,
  })
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      inputTokens = Number(chunk.usage.inputTokens ?? 0)
      outputTokens = Number(chunk.usage.outputTokens ?? 0)
      totalTokens = Number(chunk.usage.totalTokens ?? 0)
    } else if (chunk.type === 'finish') reason = chunk.reason
  }
  if (reason !== undefined && reason.kind !== 'stop' && reason.kind !== 'max-tokens' && reason.kind !== 'tool-calls') {
    // This host reports transport failures by throwing from the stream; a
    // non-terminal finish reason is the remaining failure signal.
    throw new CompilerLlmError(`model call finished with ${reason.kind}`, String(reason.kind).toUpperCase())
  }
  return { text, ms: Date.now() - started, inputTokens, outputTokens, totalTokens, stopReason: reason?.kind }
}

/**
 * Extract the model-facing text from one registry outcome.
 * @param result - a materialized tool result.
 * @returns the observation, or an error marker.
 */
export function observationOf(result: ToolExecutionResult): string {
  if (result.isError) return `Error: ${result.error?.message ?? 'tool failed'}`
  if (typeof result.value === 'string') return result.value
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')
}

/**
 * Map positional planner arguments onto one tool's JSON arguments.
 *
 * The reference engine hardcoded `search`/`math`; this generalizes it while
 * staying byte-compatible for the default vocabulary: declared parameters fill
 * in order, surplus arguments are dropped, absent ones are omitted (an explicit
 * `context: undefined` is rejected by the registry), and scalars are coerced to
 * text as the reference did.
 * @param spec - the tool's planner signature.
 * @param args - substituted positional arguments.
 * @returns the registry arguments.
 */
export function buildArguments(spec: ToolSpec, args: readonly PlanArgument[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const coerce = spec.coerce ?? 'string'
  spec.parameters.forEach((name, index) => {
    const value = args[index]
    if (value === undefined) return
    if (Array.isArray(value)) out[name] = coerce === 'string' ? value.map(item => String(item)) : value
    else out[name] = coerce === 'string' ? String(value) : value
  })
  return out
}

/**
 * Run the planner, task fetching unit, executor, and joiner once.
 * @param deps - host runtime.
 * @param settings - engine configuration.
 * @param question - the user question.
 * @param signal - caller cancellation.
 * @returns the engine's measurements and the final answer.
 */
export async function runCompiler(
  deps: CompilerDeps,
  settings: CompilerSettings,
  question: string,
  signal: AbortSignal,
): Promise<CompilerMetrics> {
  const specs = toolSpecsOf(settings.tools)
  const byName = new Map(specs.map(spec => [spec.name, spec]))
  const joinerPrompt = settings.joinerPrompt ?? JOINER_PROMPT
  const rounds = settings.maxReplans + 1

  const metrics: CompilerMetrics = {
    plannerMs: 0, executeMs: 0, joinerMs: 0,
    llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    planTasks: 0, planWaves: 0, maxWidth: 0, replans: 0,
    plans: [], tasks: [], answer: '', answerTolerant: '', joinerRaw: '',
  }
  let previousContext = ''
  let lastJoin: JoinerOutput = { thought: '', answer: '', isReplan: false, tolerantAnswer: '' }

  const planSystem = (isReplan: boolean): string =>
    settings.plannerPrompt ?? plannerSystemPrompt(specs, isReplan)

  const account = (call: CallResult, phase: 'planner' | 'joiner'): void => {
    metrics.llmCalls += 1
    metrics.inputTokens += call.inputTokens
    metrics.outputTokens += call.outputTokens
    metrics.totalTokens += call.totalTokens
    if (phase === 'planner') metrics.plannerMs += call.ms
    else metrics.joinerMs += call.ms
  }

  const joinRound = async (scratchpad: string): Promise<void> => {
    let text = ''
    // One retry when the completion carries no Finish/Replan action line.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const joined = await callModel(deps, settings, {
        user: `${joinerPrompt}\nQuestion: ${question}\n\n${scratchpad}\n`,
        signal,
      })
      account(joined, 'joiner')
      text = joined.text
      lastJoin = parseJoinerOutput(joined.text)
      if (lastJoin.answer !== '' || lastJoin.isReplan) break
    }
    metrics.answer = lastJoin.answer
    metrics.answerTolerant = lastJoin.tolerantAnswer
    metrics.joinerRaw = text
  }

  for (let round = 0; round < rounds; round += 1) {
    const isReplan = round > 0
    let planText = ''
    let tasks: PlanTask[] = []
    // One planner retry on an empty or unparseable plan: the gateway
    // occasionally returns an empty completion at temperature 0.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const plan = await callModel(deps, settings, {
        system: planSystem(isReplan),
        user: `${previousContext}${isReplan ? 'Current Plan:\n\n' : ''}Question: ${question}`,
        signal,
      })
      account(plan, 'planner')
      planText = plan.text
      tasks = parsePlan(plan.text)
      if (tasks.some(task => task.tool !== 'join')) break
    }
    const executable = tasks.filter(task => task.tool !== 'join')
    if (executable.length === 0) {
      // Upstream still calls the joiner with an empty scratchpad: it answers
      // from its own knowledge instead of failing the turn.
      deps.trace?.('plan-empty', { round })
      await joinRound('')
      break
    }

    metrics.planTasks += executable.length
    metrics.plans.push({
      question, round, plan: planText,
      tasks: executable.map(task => ({ id: task.id, tool: task.tool, args: task.args, deps: task.deps })),
    })

    const observations = new Map<number, string>()
    const perTask: ExecutedTask[] = []
    const order = (id: number): number => executable.findIndex(task => task.id === id)
    const started = Date.now()
    for (const wave of scheduleWaves(executable)) {
      metrics.planWaves += 1
      metrics.maxWidth = Math.max(metrics.maxWidth, wave.length)
      deps.trace?.('wave', { round, width: wave.length, tasks: wave.map(task => task.id) })
      for (let offset = 0; offset < wave.length; offset += settings.maxParallel) {
        await Promise.all(wave.slice(offset, offset + settings.maxParallel).map(async task => {
          const args = substitute(task.args, observations)
          const taskStart = Date.now()
          const spec = byName.get(task.tool)
          let observation: string
          if (spec === undefined) {
            observation = `Error: unknown plan action ${task.tool}`
          } else {
            try {
              const result = await deps.execute({
                callId: `${settings.callIdPrefix}-${round}-${task.id}` as ToolCallId,
                name: task.tool,
                arguments: buildArguments(spec, args),
                signal,
                ...(deps.agent === undefined ? {} : { agent: deps.agent }),
              })
              observation = observationOf(result)
            } catch (error) {
              observation = `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          }
          const truncated = observation.length > settings.maxToolOutputChars
          const stored = truncated ? observation.slice(0, settings.maxToolOutputChars) : observation
          observations.set(task.id, stored)
          perTask.push({
            id: task.id, tool: task.tool, args: task.args, resolvedArgs: args, deps: task.deps,
            ms: Date.now() - taskStart, observation: stored, truncated,
          })
          deps.trace?.('task-end', { round, id: task.id, tool: task.tool, ms: Date.now() - taskStart, truncated })
        }))
      }
    }
    metrics.executeMs += Date.now() - started
    // Plan order, not completion order: the scratchpad and the report follow the plan.
    perTask.sort((left, right) => order(left.id) - order(right.id))
    metrics.tasks = perTask

    const scratchpad = perTask
      .map(task => `Thought: ${executable[order(task.id)].thought}\n${task.tool}(${stringifyArgs(task.resolvedArgs)})\nObservation: ${task.observation}\n`)
      .join('')
    await joinRound(scratchpad)
    if (!lastJoin.isReplan) break
    metrics.replans += 1
    previousContext = ['Previous Plan:\n\n', scratchpad, `${lastJoin.thought}\n\n`].join('')
  }

  if (settings.metricsPath !== undefined) {
    try { appendFileSync(settings.metricsPath, `${JSON.stringify({ question, ...metrics })}\n`) }
    catch { /* Metrics must never fail a compiled turn. */ }
  }
  return metrics
}
