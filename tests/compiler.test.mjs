import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import { loadExecutor } from './fixtures/executor.mjs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as compiler from '../lib/compiler/index.js'
import {
  dependenciesOf, parseArgs, parseJoinerOutput, parsePlan, scheduleWaves, stringifyArgs, substitute,
} from '../lib/compiler/plan.js'
import { JOINER_PROMPT, defaultTools, plannerSystemPrompt } from '../lib/compiler/prompts.js'
import { buildArguments, observationOf, runCompiler } from '../lib/compiler/engine.js'

const sha = text => createHash('sha256').update(text).digest('hex')

// The reference demo (liuyang1271/notes src/bench-parallelqa-dag/dsh-demo/engine.mjs)
// hashes. Equality here is the parity contract for the whole prompt surface.
const REFERENCE_PROMPT_HASHES = {
  planner: '1a40235bf75fc4ac932ba89d726ef2e31648ee5be530c663046d986cd6f658ef',
  replan: '58d2000fe36fbe22c1f9fb8e5cc9ab6ee1d71eec859899e12ec5021e00746ada',
  joiner: 'f35750cd8e11ab5bdbcb3d4b64d302272e48e6531e425782e8a1c701ffc4f663',
}

test('prompts are byte-identical to the reference LLMCompiler port', () => {
  assert.equal(sha(plannerSystemPrompt(defaultTools(), false)), REFERENCE_PROMPT_HASHES.planner)
  assert.equal(sha(plannerSystemPrompt(defaultTools(), true)), REFERENCE_PROMPT_HASHES.replan)
  assert.equal(sha(JOINER_PROMPT), REFERENCE_PROMPT_HASHES.joiner)
  // Upstream's off-by-one: two tools plus join are listed, the header says four.
  assert.match(plannerSystemPrompt(defaultTools(), false), /the following 4 types/u)
  assert.match(plannerSystemPrompt(defaultTools(), false), /^\s*3\. join\(\):/mu)
  assert.match(plannerSystemPrompt(defaultTools(), false), /Always call join as the last action/u)
  // The replan paragraph only appears in the replan prompt.
  assert.ok(!plannerSystemPrompt(defaultTools(), false).includes('Previous Plan'))
  assert.ok(plannerSystemPrompt(defaultTools(), true).includes('"Previous Plan"'))
})

test('plan arguments parse like ast.literal_eval', () => {
  assert.deepEqual(parseArgs(''), [])
  assert.deepEqual(parseArgs('"a"'), ['a'])
  assert.deepEqual(parseArgs("'a'"), ['a'])
  assert.deepEqual(parseArgs('"a", "b"'), ['a', 'b'])
  assert.deepEqual(parseArgs('"problem", ["$1", "$2"]'), ['problem', ['$1', '$2']])
  assert.deepEqual(parseArgs('7'), [7])
  assert.deepEqual(parseArgs('"a\\"b"'), ['a"b'])
  // An unclosed bracket keeps the raw remainder, as upstream does.
  assert.deepEqual(parseArgs('"a", ["x"'), ['a', '["x"'])
})

test('dependencies come from $id placeholders in first-seen order', () => {
  assert.deepEqual(dependenciesOf(['"x $1"', ['$2', '$1']]), [1, 2])
  assert.deepEqual(dependenciesOf(['${3}']), [3])
  assert.deepEqual(dependenciesOf(['no ids']), [])
})

test('plan parsing keeps plan order, join dependencies and the closing thought', () => {
  const raw = [
    'Thought: search both first',
    '1. search("A")',
    '2. search("B")',
    '3. math("diff", ["$1", "$2"])',
    'Thought: I can answer now.',
    '4. join()<END_OF_PLAN>',
    '5. search("ignored")',
  ].join('\n')
  const tasks = parsePlan(raw)
  assert.deepEqual(tasks.map(task => task.id), [1, 2, 3, 4])
  assert.deepEqual(tasks[2].deps, [1, 2])
  assert.deepEqual(tasks[3].deps, [1, 2, 3])
  assert.equal(tasks[1].thought, 'search both first')
  assert.equal(tasks[3].thought, 'I can answer now.')
  // Parsing stops at join, and the <END_OF_PLAN> marker is stripped from the line.
  assert.equal(tasks.at(-1).tool, 'join')
})

test('waves are greedy over satisfied dependencies and stop on a cycle', () => {
  const tasks = parsePlan(['1. search("A")', '2. search("B")', '3. math("m", ["$1", "$2"])', '4. math("n", ["$3"])'].join('\n'))
  assert.deepEqual(scheduleWaves(tasks).map(wave => wave.map(task => task.id)), [[1, 2], [3], [4]])
  const cyclic = [{ id: 1, tool: 'x', args: [], deps: [2], thought: '' }, { id: 2, tool: 'x', args: [], deps: [1], thought: '' }]
  assert.deepEqual(scheduleWaves(cyclic), [])
})

test('substitution replaces known ids only and rendering matches the reference', () => {
  const observations = new Map([[1, 'AAAA'], [2, 'BBBB']])
  assert.deepEqual(substitute(['diff of $1 and $2', ['${1}', 'literal']], observations),
    ['diff of AAAA and BBBB', ['AAAA', 'literal']])
  assert.deepEqual(substitute(['$9'], observations), ['$9'])
  assert.equal(stringifyArgs(['problem', ['AAAA', 'BBBB']]), '"problem", ["AAAA", "BBBB"]')
  assert.equal(stringifyArgs([7]), '7')
})

test('joiner output parsing follows the strict port and keeps a tolerant answer', () => {
  const finished = parseJoinerOutput('Thought: because\nAction: Finish(7345.57)')
  assert.equal(finished.answer, '7345.57')
  assert.equal(finished.thought, 'because')
  assert.equal(finished.isReplan, false)
  const replan = parseJoinerOutput('Thought: wrong file\nAction: Replan(the search missed)')
  assert.equal(replan.isReplan, true)
  // A bare Finish line and a short single line are the two tolerant fallbacks.
  assert.equal(parseJoinerOutput('Finish(912)').answer, '')
  assert.equal(parseJoinerOutput('Finish(912)').tolerantAnswer, '912')
  assert.equal(parseJoinerOutput('912').tolerantAnswer, '912')
  assert.equal(parseJoinerOutput('line one\nline two').tolerantAnswer, '')
})

test('positional arguments map onto registry arguments like the reference engine', () => {
  const [search, math] = defaultTools()
  assert.deepEqual(buildArguments(search, ['Mount Everest']), { entity: 'Mount Everest' })
  // No context argument means the key is omitted, not sent as undefined.
  assert.deepEqual(buildArguments(math, ['half of it']), { problem: 'half of it' })
  assert.deepEqual(buildArguments(math, ['diff', ['AAA', 'BBB']]), { problem: 'diff', context: ['AAA', 'BBB'] })
  assert.deepEqual(buildArguments(math, [7]), { problem: '7' })
  // An undescribed tool still gets the reference unconditional shape, so the
  // call reaches the registry and fails there instead of being skipped here.
  assert.deepEqual(buildArguments(undefined, ['A'], 'lookup'), { problem: 'A' })
  assert.deepEqual(buildArguments(undefined, ['A'], 'search'), { entity: 'A' })
  assert.deepEqual(buildArguments(undefined, ['A', ['X']], 'lookup'), { problem: 'A', context: ['X'] })
})

test('observations prefer canonical string values and mark errors', () => {
  assert.equal(observationOf({ isError: false, value: 'plain' }), 'plain')
  assert.equal(observationOf({ isError: false, value: { a: 1 }, content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), 'one\ntwo')
  assert.equal(observationOf({ isError: true, error: { message: 'boom' }, content: [] }), 'Error: boom')
})

/** A model runtime fixture: answers planner and joiner calls from one script. */
class LlmFixture extends Service {
  constructor(ctx, handler) {
    super(ctx, 'llm')
    this.handler = handler
    this.calls = []
  }

  stream(options) {
    this.calls.push(options)
    const user = (options.messages ?? []).map(message => (Array.isArray(message.content)
      ? message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      : String(message.content ?? ''))).join('\n')
    const chunks = this.handler({ system: options.system, user, request: options }, this.calls.length)
    return (async function* emit() { for (const chunk of chunks) yield chunk })()
  }
}

const text = value => [{ type: 'text-delta', index: 0, text: value }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }]

async function harness(t, { respond, config = {} }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  loadExecutor(ctx)
  await ctx.plugin(LlmFixture, respond)
  await ctx.plugin(compiler, { provider: 'fixture', model: 'fixture', trace: false, ...config })
  t.after(() => ctx.fiber.dispose())
  const executed = []
  const register = (name, execute) => ctx.tools.register({
    name, description: name,
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute,
  })
  const llm = ctx.llm
  return { ctx, llm, executed, register }
}

function loopRequest(question, extra = {}) {
  return markAgentLoopRequest({
    provider: 'fixture', model: 'fixture', sessionId: 'session-fixture',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } },
    ],
    ...extra,
  })
}

test('the compiler replaces the loop call and answers from the compiled plan', async t => {
  const { ctx, executed, register } = await harness(t, {
    respond: (options, index) => index === 1
      ? text('1. search("A")\n2. search("B")\n3. math("diff", ["$1", "$2"])\nThought: computed.\n4. join()<END_OF_PLAN>')
      : text('Thought: done\nAction: Finish(42)'),
  })
  register('search', async args => { executed.push(['search', args.entity]); return `page:${args.entity}` })
  register('math', async args => { executed.push(['math', args.problem, args.context]); return '42' })

  const request = loopRequest('difference of A and B')
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', request, () => { throw new Error('the adapter must not be reached') })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map(chunk => chunk.type), ['text-delta', 'usage', 'finish'])
  assert.equal(chunks[0].text, '42')
  assert.equal(chunks[1].usage.inputTokens, 20)
  assert.equal(chunks[2].reason.kind, 'stop')
  // Both searches ran; math received the substituted upstream observations.
  assert.deepEqual(executed, [
    ['search', 'A'], ['search', 'B'], ['math', 'diff', ['page:A', 'page:B']],
  ])
})

test('non-loop requests fall through, and the compiler never compiles its own calls', async t => {
  const { ctx, llm, register, executed } = await harness(t, {
    respond: (options, index) => index === 1
      ? text('1. search("A")\nThought: ok.\n2. join()<END_OF_PLAN>')
      : text('Action: Finish(1)'),
  })
  // A hand-built one-shot call carries `system` and is not marked: untouched.
  const passthrough = []
  ctx.on('llm/stream', (options, next) => { passthrough.push(options.system); return next() })
  register('search', async args => { executed.push(args.entity); return 'page:A' })
  const oneShot = { provider: 'fixture', model: 'fixture', system: 'system prompt', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', oneShot, () => (async function* passthroughStream() { yield { type: 'text-delta', index: 0, text: 'adapter' } })())) chunks.push(chunk)
  assert.equal(chunks[0].text, 'adapter')
  // Its own planner/joiner calls reach the adapter, not another compilation.
  const compiled = []
  for await (const chunk of ctx.waterfall('llm/stream', loopRequest('q'), () => (async function* never() { throw new Error('adapter must not be reached') })())) compiled.push(chunk)
  assert.equal(compiled[0].text, '1')
  assert.ok(llm.calls.length >= 2)
  assert.ok(llm.calls.every(call => call.system === undefined || typeof call.system === 'string'))
  assert.deepEqual(passthrough, ['system prompt'])
})

test('a replan round feeds the previous plan back and can finish on the second try', async t => {
  const { ctx, register } = await harness(t, {
    respond: (options, index) => {
      if (index === 1) return text('1. search("A")\nThought: one.\n2. join()<END_OF_PLAN>')
      if (index === 2) return text('Thought: not enough\nAction: Replan(need more)')
      if (index === 3) {
        assert.match(options.user, /Previous Plan/u)
        assert.match(options.user, /Current Plan:/u)
        return text('1. search("B")\nThought: two.\n2. join()<END_OF_PLAN>')
      }
      return text('Thought: done\nAction: Finish(7)')
    },
  }, { config: { maxReplans: 1 } })
  register('search', async args => `page:${args.entity}`)
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', loopRequest('q'), () => { throw new Error('adapter') })) chunks.push(chunk)
  assert.equal(chunks[0].text, '7')
})

test('an empty plan still asks the joiner, as upstream does', async t => {
  const deps = {
    stream: () => (async function* emptyPlan() {
      yield { type: 'text-delta', index: 0, text: '' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    execute: async () => { throw new Error('no tool should run') },
  }
  let calls = 0
  const settings = { provider: 'p', model: 'm', temperature: 0, maxTokens: 16, maxReplans: 0, maxParallel: 2, maxToolOutputChars: 128, tools: defaultTools(), callIdPrefix: 'dag' }
  const metrics = await runCompiler({
    ...deps,
    stream: (options) => {
      calls += 1
      return (async function* answer() {
        yield { type: 'text-delta', index: 0, text: options.system === undefined ? 'Action: Finish(from knowledge)' : '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }, settings, 'q', new AbortController().signal)
  assert.equal(calls, 3)
  assert.equal(metrics.answer, 'from knowledge')
  assert.equal(metrics.planTasks, 0)
})

test('configuration bounds and defaults match the reference run', () => {
  const base = compiler.Config({ provider: 'p', model: 'm' })
  assert.equal(base.maxReplans, 1)
  assert.equal(base.maxParallel, 0)          // 0 = send the whole wave at once, as the reference does
  assert.equal(base.maxToolOutputChars, 0)   // 0 = never truncate, as the reference does
  assert.equal(base.detect, 'heuristic')     // the reference demo's structural discriminator
  assert.equal(base.tools.length, 2)
  assert.equal(base.maxTokens, 2048)         // the reference engine own default
  assert.throws(() => compiler.Config({}))   // route is required
  assert.throws(() => compiler.Config({ provider: 'p', model: 'm', maxParallel: 65 }))
  assert.throws(() => compiler.Config({ provider: 'p', model: 'm', maxParallel: -1 }))
  assert.equal(typeof compiler.name, 'string')
})

test('marked loop requests are recognised through the harness marker', () => {
  assert.equal(isAgentLoopRequest(loopRequest('q')), true)
  assert.equal(isAgentLoopRequest({ provider: 'p', model: 'm', messages: [] }), false)
  assert.equal(compiler.isLoopRequestByHeuristic(loopRequest('q')), true)
  assert.equal(compiler.questionOf(loopRequest('the question')), 'the question')
})
test('the default discriminator compiles an unmarked loop-shaped request', async t => {
  const { ctx, register } = await harness(t, {
    respond: (options, index) => index === 1
      ? text('1. search("A")\nThought: ok.\n2. join()<END_OF_PLAN>')
      : text('Action: Finish(9)'),
  })
  register('search', async () => 'page')
  // Not marked by the loop: only the reference demo's structural heuristic
  // identifies it, which is the default discriminator.
  const request = {
    provider: 'fixture', model: 'fixture',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } },
    ],
  }
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', request, () => { throw new Error('adapter must not be reached') })) chunks.push(chunk)
  assert.equal(chunks[0].text, '9')
})

test('a compiled turn with no answer says so instead of sending an empty message', async t => {
  const { ctx, register } = await harness(t, {
    respond: (options, index) => index === 1
      ? text('1. search("A")\n2. join()<END_OF_PLAN>')
      : text(''),
  })
  register('search', async () => 'page')
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', loopRequest('q'), () => { throw new Error('adapter') })) chunks.push(chunk)
  const said = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.notEqual(said, '')
  assert.match(said, /no answer/u)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('emptyAnswer: error fails the call rather than inventing an answer', async t => {
  const { ctx, register } = await harness(t, {
    respond: (options, index) => index === 1
      ? text('1. search("A")\n2. join()<END_OF_PLAN>')
      : text(''),
    config: { emptyAnswer: 'error' },
  })
  register('search', async () => 'page')
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', loopRequest('q'), () => { throw new Error('adapter') })) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['finish'])
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'DAG_COMPILER_EMPTY_ANSWER')
})

test('the configured reasoning effort reaches both planner and joiner calls', async t => {
  const { ctx, llm, register } = await harness(t, {
    respond: (options, index) => index === 1
      ? text('1. search("A")\n2. join()<END_OF_PLAN>')
      : text('Action: Finish(1)'),
    config: { reasoningEffort: 'off' },
  })
  register('search', async () => 'page')
  const chunks = []
  for await (const chunk of ctx.waterfall('llm/stream', loopRequest('q'), () => { throw new Error('adapter') })) chunks.push(chunk)
  assert.ok(llm.calls.length >= 2)
  assert.ok(llm.calls.every(call => call.reasoningEffort === 'off'))
})
