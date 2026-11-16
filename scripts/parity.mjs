/**
 * Differential parity check against the reference implementation.
 *
 * Runs the reference engine's own exported functions side by side with this
 * port over a corpus of inputs and asserts deep equality, then compares the
 * three prompts byte for byte. The reference file is not vendored here; point
 * this script at your checkout of it:
 *
 *   node scripts/parity.mjs /path/to/notes/src/bench-parallelqa-dag/dsh-demo/engine.mjs
 *
 * Reference: liuyang1271/notes · src/bench-parallelqa-dag/dsh-demo/engine.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import * as port from '../lib/compiler/plan.js'
import * as portPrompts from '../lib/compiler/prompts.js'

const referencePath = process.argv[2]
if (referencePath === undefined) {
  console.error('usage: node scripts/parity.mjs <path-to-reference-engine.mjs>')
  process.exit(2)
}
const ref = await import(pathToFileURL(referencePath).href)

const results = []
const check = (name, body) => {
  try { body(); results.push(['MATCH', name, '']) }
  catch (error) { results.push(['DIFF ', name, error.message.split('\n')[0]]) }
}

// Argument lists, including upstream's odd corners.
const ARG_CORPUS = [
  '', '   ', '"a"', "'a'", '"a", "b"', '1, 2, 3', '"x", ["$1", "$2"]', '"a\\"b"',
  '[1, 2, 3]', '[]', '["only"]', '"a", ["x"', '7', '-3.5', 'null', 'True', '"a b", 2',
  "'it\\'s'", '"multi\nline"', '"t\tab"', '["$1","$2"], "x"', '"unclosed', 'a, b',
]
for (const input of ARG_CORPUS) {
  check(`parseArgs(${JSON.stringify(input)})`, () => assert.deepEqual(port.parseArgs(input), ref.parseArgs(input)))
}

const DEP_CORPUS = [['"x"'], [['$1', '$2']], ['${3}'], ['$1 and $1'], [[]], [['a', ['$7']]], ['no ids']]
for (const input of DEP_CORPUS) {
  check(`dependenciesOf(${JSON.stringify(input)})`,
    () => assert.deepEqual(port.dependenciesOf(input), ref.dependenciesOf(input)))
}

const observations = new Map([[1, 'AAAA'], [2, 'BBBB'], [9, '']])
const SUBST_CORPUS = [['$1'], [['$1', '$2']], ['a $1 b ${2} c'], ['$9'], ['$3'], ['plain'], [7]]
for (const input of SUBST_CORPUS) {
  check(`substitute(${JSON.stringify(input)})`,
    () => assert.deepEqual(port.substitute(input, observations), ref.substitute(input, observations)))
  check(`stringifyArgs(${JSON.stringify(input)})`,
    () => assert.equal(port.stringifyArgs(input), ref.stringifyArgs(input)))
}

const PLAN_CORPUS = [
  '1. search("A")\n2. search("B")\n3. math("diff", ["$1", "$2"])\nThought: go\n4. join()<END_OF_PLAN>',
  'Thought: t\n1. search("A")\n2. join()',
  '1. search("A")\n</END_OF_PLAN>\n2. join()\n3. search("never")',
  'garbage line\nnot a plan',
  '1. join()',
  '1. search("A")\n2. math("m", ["${1}"])',
  `1. search("A")\n2. join()${ref.END_OF_PLAN}`,
]
const pick = task => ({ id: task.id, tool: task.tool, args: task.args, deps: task.deps, thought: task.thought })
for (const text of PLAN_CORPUS) {
  check(`parsePlan(${JSON.stringify(text.slice(0, 40))})`,
    () => assert.deepEqual(port.parsePlan(text).map(pick), ref.parsePlan(text).map(pick)))
  check(`scheduleWaves(${JSON.stringify(text.slice(0, 30))})`, () => {
    const mine = port.parsePlan(text).filter(task => task.tool !== 'join')
    const theirs = ref.parsePlan(text).filter(task => task.tool !== 'join')
    assert.deepEqual(
      port.scheduleWaves(mine).map(wave => wave.map(task => task.id)),
      ref.scheduleWaves(theirs).map(wave => wave.map(task => task.id)),
    )
  })
}

const JOINER_CORPUS = [
  'Thought: because\nAction: Finish(7345.57)',
  'Action: Finish(x)',
  'Action: Replan(missed)',
  'Finish(912)',
  '912',
  'line one\nline two',
  '',
  'Thought: only thought',
  'Action: Finish()',
  'Thought: t\nAction: Finish(a) \nAction: Finish(b)',
  `Action: Finish(${'y'.repeat(120)})`,
]
for (const text of JOINER_CORPUS) {
  check(`parseJoinerOutput(${JSON.stringify(text.slice(0, 30))})`,
    () => assert.deepEqual(port.parseJoinerOutput(text), ref.parseJoinerOutput(text)))
}

const sha = value => createHash('sha256').update(value).digest('hex')
for (const [name, mine, theirs] of [
  ['planner(false)', portPrompts.plannerSystemPrompt(portPrompts.defaultTools(), false), ref.plannerSystemPrompt(false)],
  ['planner(true)', portPrompts.plannerSystemPrompt(portPrompts.defaultTools(), true), ref.plannerSystemPrompt(true)],
  ['joiner', portPrompts.JOINER_PROMPT, ref.JOINER_PROMPT],
]) {
  check(`prompt ${name}`, () => {
    assert.equal(sha(mine), sha(theirs))
    assert.equal(mine, theirs)
  })
}

const failed = results.filter(([status]) => status === 'DIFF ')
for (const [status, name, detail] of results) console.log(`${status} ${name}${detail === '' ? '' : ` -> ${detail}`}`)
console.log(`\n${results.length - failed.length}/${results.length} identical`)
if (failed.length > 0) process.exitCode = 1
