/**
 * Prompt builders for the compile-style orchestration loop.
 *
 * Kept free of any DSH import so they can be unit-tested and reused by either seam
 * (a tool, or the `llm/stream` waterfall).
 */

export interface PlannerTool {
  name: string
  description: string
}

export interface PlannerPromptOptions {
  /** Tools the planner may reference, in the order they should be described. */
  tools: readonly PlannerTool[]
  /** Extra rules appended verbatim, one bullet each. */
  guidelines?: readonly string[]
  /** Whether this is the first plan of the turn or a replan. */
  replan?: boolean
  /** Tool name that marks the join sentinel. Defaults to `join`. */
  joinTool?: string
}

const DEFAULT_GUIDELINES: readonly string[] = [
  'Keep each round small: 1-4 actions per plan.',
  'Read-only actions that do not depend on each other may share a round without a reference.',
  'Use $n only when a later action needs an earlier action output as an argument.',
  'Never repeat an action that already ran in the previous plan; use its observation instead.',
  'Always finish the plan with join() and the end-of-plan marker.',
]

export const END_OF_PLAN = '<END_OF_PLAN>'

export function plannerSystemPrompt(options: PlannerPromptOptions): string {
  const join = options.joinTool ?? 'join'
  const guidelines = options.guidelines ?? DEFAULT_GUIDELINES
  const lines: string[] = [
    'Given a user query, create a plan that solves it with the utmost parallelizability.',
    'Each plan comprises actions from the following types:',
  ]
  options.tools.forEach((tool, index) => {
    lines.push(`${index + 1}. ${tool.name}(...): ${tool.description}`)
  })
  lines.push(`${options.tools.length + 1}. ${join}(): Collect and combine results from prior actions and stop planning.`)
  lines.push('', 'Guidelines:')
  for (const rule of guidelines) lines.push(` - ${rule}`)
  lines.push(
    ' - Number actions consecutively from 1; each of the following actions MUST have a unique, strictly increasing id.',
    ' - Inputs can be constants or outputs of preceding actions, written as $id.',
    ` - Say ${END_OF_PLAN} right after the ${join} action.`,
    ' - Never explain the plan with comments and never introduce actions other than the ones above.',
  )
  if (options.replan) {
    lines.push(
      ' - You are given "Previous Plan" with the execution observations and a "Thought" about them.',
      ' - Create the next plan under "Current Plan" and start it with a Thought outlining the strategy.',
      ' - Never repeat actions already executed in the Previous Plan.',
    )
  }
  return lines.join('\n')
}

export interface PlannerRequest {
  system: string
  user: string
}

export function plannerRequest(question: string, previous: string, replan: boolean): PlannerRequest {
  const user = replan
    ? `Question: ${question}\n${previous}Current Plan:\n\n`
    : `Question: ${question}`
  return { system: '', user }
}

export const JOINER_RULES: readonly string[] = [
  'Your entire reply is at most two lines: one optional Thought line, then exactly one Action line.',
  'NEVER continue the work yourself: no tool calls, no invented observations, no commands in the Thought.',
  'Finish ONLY when an edit or the required change was actually applied.',
  'If a test ran and failed, you MUST Replan.',
  'Do not Replan to repeat work that is already done.',
]

export function joinerPrompt(question: string, scratchpad: string, rules: readonly string[] = JOINER_RULES): string {
  return [
    'You are the joiner of an agent. You are given the question, the plan that was just executed,',
    'and the observations. Decide whether the task is complete.',
    '',
    'RULES:',
    ...rules.map(rule => ` - ${rule}`),
    '',
    'Action can be only one type:',
    ' (1) Finish(summary): the task is complete. One or two sentences: what changed and how it was verified.',
    ' (2) Replan(reason): more work is needed. One sentence naming what still has to be done.',
    '',
    `Question: ${question}`,
    '',
    scratchpad,
  ].join('\n')
}

export type JoinerDecision =
  | { kind: 'finish'; summary: string; thought: string }
  | { kind: 'replan'; reason: string; thought: string }
  | { kind: 'unknown'; raw: string }

const ACTION = /^\s*(?:Action\s*[:：]\s*)?(Finish|Replan)\s*\((.*)\)\s*$/u
const THOUGHT_LINE = /^\s*(?:Thought|思考)\s*[:：]\s*(.*)$/u

/** Parse a joiner reply, tolerating a missing `Action:` prefix and a trailing `)`. */
export function parseJoiner(text: string): JoinerDecision {
  let thought = ''
  for (const line of String(text).split('\n')) {
    const thoughtMatch = THOUGHT_LINE.exec(line)
    if (thoughtMatch) { thought = thoughtMatch[1]!.trim(); continue }
    const action = ACTION.exec(line)
    if (!action) continue
    const body = action[2]!.trim()
    if (action[1] === 'Finish') return { kind: 'finish', summary: body, thought }
    return { kind: 'replan', reason: body, thought }
  }
  return { kind: 'unknown', raw: String(text) }
}
