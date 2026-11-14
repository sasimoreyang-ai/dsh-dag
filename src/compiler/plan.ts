import type { Json } from '../graph.js'

/** One executable task in a compiled plan. */
export interface PlanTask {
  /** Stable node id derived from the plan line number. */
  id: string
  /** Tool name as written by the planner. */
  tool: string
  /** Positional arguments, already parsed from the plan text. */
  args: Json[]
  /** Ids this task depends on, derived from `$n` references. */
  dependsOn: string[]
  /** Last `Thought:` line that preceded this task, if any. */
  thought: string
}

export interface ParsedPlan {
  tasks: PlanTask[]
  /** Every `Thought:` line in order, including trailing ones with no task. */
  thoughts: string[]
  /** True when the plan contained a `join()` sentinel. */
  joinSeen: boolean
  /** True when no executable task survived parsing. */
  empty: boolean
}

export interface ParseOptions {
  /** Tools that may appear as executable tasks; unknown names are ignored. */
  knownTools: ReadonlySet<string>
  /** Hard cap on parsed tasks; the remainder is dropped. */
  maxTasks: number
  /** Tools that mark a join sentinel instead of executing. Defaults to `join`. */
  joinTools?: ReadonlySet<string>
}

const END_OF_PLAN = /<\s*\/?\s*END_OF_PLAN\s*>/giu
const NUMBERED = /^\s*(\d+)\s*[.、)]\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/u
const UNNUMBERED = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/u
const THOUGHT = /^\s*(?:Thought|思考)\s*[:：]\s*(.*)$/u
const REFERENCE = /\$\{?(\d+)\}?/gu

/**
 * Split an argument list into JSON values.
 *
 * Deliberately not a JavaScript evaluator: only strings, numbers, booleans, null and
 * flat arrays are accepted, so plan text can never execute code.
 */
export function parseArguments(raw: string): Json[] {
  const text = raw.trim()
  if (text === '') return []
  const values: Json[] = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index]!)) index += 1
    if (index >= text.length) break
    const char = text[index]!
    if (char === '[') {
      const end = matchBracket(text, index)
      if (end === -1) throw new Error('Unterminated array in plan arguments.')
      values.push(parseArguments(text.slice(index + 1, end)))
      index = end + 1
    } else if (char === '"' || char === "'") {
      const { value, next } = readString(text, index)
      values.push(value)
      index = next
    } else {
      let end = index
      while (end < text.length && text[end] !== ',') end += 1
      const token = text.slice(index, end).trim()
      if (token !== '') values.push(literal(token))
      index = end
    }
    while (index < text.length && /\s/u.test(text[index]!)) index += 1
    if (index < text.length && text[index] === ',') index += 1
  }
  return values
}

function literal(token: string): Json {
  if (token === 'true') return true
  if (token === 'false') return false
  if (token === 'null') return null
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(token)) return Number(token)
  throw new Error(`Unsupported plan argument ${token.slice(0, 32)}.`)
}

function matchBracket(text: string, start: number): number {
  let depth = 0
  let quote: string | undefined
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function readString(text: string, start: number): { value: string; next: number } {
  const quote = text[start]!
  let value = ''
  let index = start + 1
  while (index < text.length) {
    const char = text[index]!
    if (char === '\\' && index + 1 < text.length) {
      const escaped = text[index + 1]!
      value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped
      index += 2
      continue
    }
    if (char === quote) return { value, next: index + 1 }
    value += char
    index += 1
  }
  throw new Error('Unterminated string in plan arguments.')
}

/** Collect `$n` / `${n}` references from already-parsed arguments, in first-seen order. */
export function referencesOf(args: Json[]): number[] {
  const found: number[] = []
  const scan = (value: Json): void => {
    if (Array.isArray(value)) { value.forEach(scan); return }
    if (typeof value !== 'string') return
    for (const match of value.matchAll(REFERENCE)) {
      const id = Number(match[1])
      if (!found.includes(id)) found.push(id)
    }
  }
  args.forEach(scan)
  return found
}

/**
 * Parse planner output into executable tasks.
 *
 * Tolerates: missing line numbers, `END_OF_PLAN` markers, `Thought:` prefixes, and a
 * `join()` sentinel that depends on every earlier task.
 */
export function parsePlan(text: string, options: ParseOptions): ParsedPlan {
  const joinTools = options.joinTools ?? new Set(['join'])
  const tasks: PlanTask[] = []
  const thoughts: string[] = []
  let joinSeen = false
  let pendingThought = ''
  let nextIndex = 1

  for (const line of String(text).replace(END_OF_PLAN, '').split('\n')) {
    const thought = THOUGHT.exec(line)
    if (thought) {
      pendingThought = thought[1]!.trim()
      thoughts.push(pendingThought)
      continue
    }
    const numbered = NUMBERED.exec(line)
    const unnumbered = numbered ? undefined : UNNUMBERED.exec(line)
    const match = numbered ?? unnumbered
    if (!match) continue
    const index = numbered ? Number(match[1]) : nextIndex
    const tool = (numbered ? match[2] : match[1])!
    const rawArgs = (numbered ? match[3] : match[2]) ?? ''
    if (!numbered && !options.knownTools.has(tool) && !joinTools.has(tool)) continue
    nextIndex = Math.max(nextIndex, index + 1)
    if (joinTools.has(tool)) { joinSeen = true; break }
    if (!options.knownTools.has(tool)) continue
    if (tasks.length >= options.maxTasks) break
    if (tasks.some(task => task.id === `n${index}`)) {
      throw new Error(`Duplicate plan line number ${index}.`)
    }
    const args = parseArguments(rawArgs)
    const dependsOn = referencesOf(args).map(id => `n${id}`)
    tasks.push({ id: `n${index}`, tool, args, dependsOn, thought: pendingThought })
    // A Thought line annotates only the action that immediately follows it.
    pendingThought = ''
  }

  return { tasks, thoughts, joinSeen, empty: tasks.length === 0 }
}

/** Replace `$n` / `${n}` placeholders with the upstream task's rendered output. */
export function substituteReferences(args: Json[], outputs: ReadonlyMap<string, string>): Json[] {
  const replace = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(replace)
    if (typeof value !== 'string') return value
    return value.replace(REFERENCE, (whole, id: string) => outputs.get(`n${id}`) ?? whole)
  }
  return args.map(replace)
}
