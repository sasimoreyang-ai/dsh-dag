/**
 * Plan parsing, `$id` dependency inference, greedy wave scheduling, and joiner
 * output parsing — ports of `third_party/LLMCompiler`
 * (`src/llm_compiler/output_parser.py`, `src/llm_compiler/task_fetching_unit.py`,
 * `src/llm_compiler/llm_compiler.py`) as carried by the dsh ParallelQA demo.
 */

import { JOINNER_REPLAN } from './prompts.js'

const ID_PATTERN = /\$\{?(\d+)\}?/g
const PLAN_LINE = /^\s*(\d+)\.\s*([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*$/
const END_OF_PLAN_MARKER = /<\s*\/?\s*END_OF_PLAN\s*>/gi

/** One positional planner argument: a scalar or a nested list of them. */
export type PlanArgument = string | number | PlanArgument[]

/** One parsed plan step. */
export interface PlanTask {
  id: number
  tool: string
  args: PlanArgument[]
  /** Ids this task reads through `$id`; `join` depends on every earlier task. */
  deps: number[]
  /** The `Thought:` line preceding the task, when the plan carried one. */
  thought: string
}

/** Parsed joiner output, with the loosely parsed answer kept separately. */
export interface JoinerOutput {
  thought: string
  /** Strict port of `_parse_joinner_output`: text inside `Action: Finish(...)`. */
  answer: string
  isReplan: boolean
  /**
   * What the same output would answer under looser parsing — a bare
   * `Finish(...)` line, or a short single-line output with neither prefix. This
   * model family occasionally answers without the `Action:` prefix; the strict
   * `answer` stays faithful to the port while this one is what a caller can
   * fall back to.
   */
  tolerantAnswer: string
}

/**
 * Parse one argument list the way `output_parser.py` reaches Python's
 * `ast.literal_eval`: quoted strings, string arrays, numbers, and anything else
 * as raw text.
 * @param raw - the text inside the parentheses.
 * @returns the positional arguments.
 */
export function parseArgs(raw: string): PlanArgument[] {
  const text = raw.trim()
  if (text === '') return []
  const values: PlanArgument[] = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1
    if (index >= text.length) break
    const ch = text[index]
    if (ch === '[') {
      const end = text.indexOf(']', index)
      if (end === -1) { values.push(text.slice(index)); break }
      values.push(parseArgs(text.slice(index + 1, end)))
      index = end + 1
    } else if (ch === '"' || ch === "'") {
      let end = index + 1
      let value = ''
      while (end < text.length) {
        if (text[end] === '\\' && end + 1 < text.length) {
          const escaped = text[end + 1]
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
          end += 2
          continue
        }
        if (text[end] === ch) break
        value += text[end]
        end += 1
      }
      values.push(value)
      index = end + 1
    } else {
      let end = index
      while (end < text.length && text[end] !== ',') end += 1
      const token = text.slice(index, end).trim()
      if (token !== '') {
        const numeric = Number(token)
        values.push(Number.isFinite(numeric) && /^[-+0-9.eE]+$/.test(token) ? numeric : token)
      }
      index = end
    }
    while (index < text.length && /\s/.test(text[index])) index += 1
    if (text[index] === ',') index += 1
  }
  return values
}

/**
 * Read the `$id` placeholders out of one argument list
 * (`output_parser.py: default_dependency_rule`).
 * @param args - positional arguments.
 * @returns the referenced task ids in first-seen order.
 */
export function dependenciesOf(args: readonly PlanArgument[]): number[] {
  const deps: number[] = []
  const scan = (value: PlanArgument): void => {
    if (Array.isArray(value)) { for (const item of value) scan(item); return }
    for (const match of String(value).matchAll(ID_PATTERN)) {
      const id = Number(match[1])
      if (!deps.includes(id)) deps.push(id)
    }
  }
  for (const arg of args) scan(arg)
  return deps
}

/**
 * Parse a plan into ordered tasks. `join` depends on every earlier task, and the
 * plan ends there — exactly what `output_parser.py` does.
 * @param text - raw planner output.
 * @returns the parsed tasks, including the terminal `join` when present.
 */
export function parsePlan(text: string): PlanTask[] {
  const tasks: PlanTask[] = []
  let thought = ''
  for (const line of String(text).replace(END_OF_PLAN_MARKER, '').split('\n')) {
    const thoughtMatch = /^\s*Thought:\s*(.*)$/.exec(line)
    if (thoughtMatch !== null) {
      thought = thoughtMatch[1].trim()
      continue
    }
    const match = PLAN_LINE.exec(line)
    if (match === null) continue
    const id = Number(match[1])
    const tool = match[2]
    const args = parseArgs(match[3])
    const deps = tool === 'join' ? tasks.map(task => task.id) : dependenciesOf(args)
    tasks.push({ id, tool, args, deps, thought })
    if (tool === 'join') break
  }
  return tasks
}

/**
 * Replace `$id` / `${id}` placeholders with upstream observations
 * (`task_fetching_unit.py: _replace_arg_mask_with_real_value`). Unknown ids are
 * left verbatim, as upstream leaves them.
 * @param args - the task's arguments.
 * @param observations - task id to observation text.
 * @returns the substituted arguments.
 */
export function substitute(args: readonly PlanArgument[], observations: ReadonlyMap<number, string>): PlanArgument[] {
  const replace = (value: PlanArgument): PlanArgument => {
    if (Array.isArray(value)) return value.map(replace)
    if (typeof value !== 'string') return value
    return value.replace(/\$\{?(\d+)\}?/g, (whole, id: string) => {
      const found = observations.get(Number(id))
      return found === undefined ? whole : found
    })
  }
  return args.map(replace)
}

/**
 * Render one argument list back to `tool(args)` text (`stringify_rule`).
 * @param args - positional arguments.
 * @returns the rendered call arguments.
 */
export function stringifyArgs(args: readonly PlanArgument[]): string {
  return args.map(arg => (Array.isArray(arg)
    ? `[${arg.map(item => JSON.stringify(item)).join(', ')}]`
    : JSON.stringify(arg))).join(', ')
}

/**
 * Greedy ready-wave schedule (`task_fetching_unit.py: schedule`): each round
 * takes every remaining task whose dependencies already executed.
 * @param tasks - the executable (non-join) tasks in plan order.
 * @returns waves of tasks; a dependency cycle leaves tasks unscheduled.
 */
export function scheduleWaves(tasks: readonly PlanTask[]): PlanTask[][] {
  const remaining = new Map(tasks.map(task => [task.id, task]))
  const waves: PlanTask[][] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(task => task.deps.every(dep => !remaining.has(dep)))
    if (ready.length === 0) break
    waves.push(ready)
    for (const task of ready) remaining.delete(task.id)
  }
  return waves
}

/**
 * Read the joiner's `Thought:` / `Action: Finish(...)` answer
 * (`llm_compiler.py: _parse_joinner_output`).
 * @param raw - the joiner completion.
 * @returns the strict answer, the replan flag, and the tolerant fallback.
 */
export function parseJoinerOutput(raw: string): JoinerOutput {
  let thought = ''
  let answer = ''
  let isReplan = false
  const text = String(raw)
  for (const line of text.split('\n')) {
    if (line.startsWith('Action:')) {
      answer = line.slice(line.indexOf('(') + 1, line.indexOf(')'))
      isReplan = line.includes(JOINNER_REPLAN)
    } else if (line.startsWith('Thought:')) {
      thought = line.split('Thought:')[1].trim()
    }
  }
  const tolerantMatch = /(?:^|\n)\s*(?:Action:\s*)?Finish\((.*?)\)/.exec(text)
  const trimmed = text.trim()
  let tolerantAnswer = tolerantMatch === null ? answer : tolerantMatch[1].trim()
  if (tolerantAnswer === '' && trimmed !== '' && !trimmed.includes('\n') && trimmed.length < 80) {
    tolerantAnswer = trimmed
  }
  return { thought, answer, isReplan, tolerantAnswer }
}
