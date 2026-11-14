import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as dag from '../lib/index.js'
import { validateGraph, resolveArguments } from '../lib/graph.js'

async function setup(t, config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const fork = await ctx.plugin(dag, { trace: false, ...config })
  t.after(() => ctx.fiber.dispose())
  const agent = { id: 'test-session' }
  const call = (nodes, options = {}) => ctx.tools.execute({
    name: 'dag_execute', callId: ToolCallId('root'), arguments: { nodes, ...options.args },
    agent: options.agent ?? agent, signal: options.signal ?? new AbortController().signal,
  })
  const register = (name, execute, parallel = true) => ctx.tools.register({
    name, description: name,
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute, isConcurrencySafe: () => parallel,
  })
  return { ctx, fork, agent, call, register }
}

const node = (id, tool = 'echo', args = {}, dependsOn = []) => ({ id, tool, arguments: args, dependsOn })
const ref = (id, pointer = '') => ({ $dagRef: { node: id, pointer } })
const statuses = result => result.value.nodes.map(node => node.status)

test('exact rc.2 runtime exposes a native DAG tool and unregisters on disposal', async t => {
  const { ctx, fork } = await setup(t)
  assert.ok(ctx.tools.schemas().some(tool => tool.name === 'dag_execute'))
  assert.equal(ctx.tools.executionMode({ name: 'dag_execute', arguments: {}, signal: new AbortController().signal }).kind, 'exclusive')
  await fork.dispose()
  assert.equal(ctx.tools.get('dag_execute'), undefined)
})

test('dependency values resolve and output contains node timings and policy projections', async t => {
  const { register, call } = await setup(t)
  register('echo', async args => args)
  const result = await call([node('a', 'echo', { answer: 42 }), node('b', 'echo', { value: ref('a', '/answer') }, ['a'])])
  assert.equal(result.isError, false)
  assert.deepEqual(statuses(result), ['succeeded', 'succeeded'])
  assert.equal(JSON.parse(JSON.parse(result.value.nodes[1].output)[0].text).value, 42)
  assert.ok(result.value.nodes.every(node => node.durationMs >= 0))
})

test('rolling dispatch starts a dependent before an unrelated slow branch finishes', async t => {
  const { register, call } = await setup(t, { maxConcurrency: 2 })
  const events = []
  let releaseSlow
  const slowGate = new Promise(resolve => { releaseSlow = resolve })
  register('work', async args => {
    events.push(`start-${args.id}`)
    if (args.id === 'slow') await slowGate
    if (args.id === 'child') releaseSlow()
    events.push(`end-${args.id}`)
    return args.id
  })
  const watchdog = setTimeout(releaseSlow, 2000)
  t.after(() => clearTimeout(watchdog))
  const result = await call([
    node('fast', 'work', { id: 'fast' }), node('slow', 'work', { id: 'slow' }),
    node('child', 'work', { id: 'child' }, ['fast']),
  ])
  assert.deepEqual(statuses(result), ['succeeded', 'succeeded', 'succeeded'])
  assert.ok(events.indexOf('start-child') < events.indexOf('end-slow'))
})

test('parallel cap and exclusive barrier follow actual tool classifications', async t => {
  const { register, call } = await setup(t, { maxConcurrency: 2 })
  let active = 0
  let peak = 0
  const work = async () => { active++; peak = Math.max(peak, active); await delay(15); active--; return null }
  register('read', work)
  register('write', async () => { assert.equal(active, 0); await work(); return 'written' }, false)
  const result = await call([node('a', 'read'), node('b', 'read'), node('c', 'write'), node('d', 'read')])
  assert.deepEqual(statuses(result), Array(4).fill('succeeded'))
  assert.equal(peak, 2)
})

test('invalid graph, unknown tools and invalid literal arguments execute nothing', async t => {
  const { ctx, register, call } = await setup(t)
  let executions = 0
  register('echo', async () => { executions++; return null })
  ctx.tools.register({ name: 'typed', description: '', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    output: { schema: {}, render: () => [] }, execute: async () => { executions++; return null } })
  const graphs = [
    [node('a'), node('a')], [node('a', 'echo', {}, ['missing'])],
    [node('a', 'echo', {}, ['b']), node('b', 'echo', {}, ['a'])],
    [node('a'), node('b', 'unknown')], [node('a'), node('b', 'typed', { n: 'bad' })],
    [node('a'), node('b', 'echo', { x: ref('a') })],
    [node('a', 'dag_execute')],
  ]
  for (const graph of graphs) assert.equal((await call(graph)).isError, true)
  assert.equal(executions, 0)
})

test('failures block descendants, independent branches continue, and stop skips queued work', async t => {
  const { register, call } = await setup(t, { maxConcurrency: 1 })
  register('fail', async () => { throw new Error('fixture failure') })
  register('echo', async () => 'ok')
  const graph = [node('a', 'fail'), node('b', 'echo', {}, ['a']), node('c')]
  assert.deepEqual(statuses(await call(graph)), ['failed', 'blocked', 'succeeded'])
  assert.deepEqual(statuses(await call(graph, { args: { failurePolicy: 'stop' } })), ['failed', 'blocked', 'skipped'])
})

test('invalid dynamic references fail a node before its tool body', async t => {
  const { register, call } = await setup(t)
  register('echo', async args => args)
  const result = await call([node('a'), node('b', 'echo', { x: ref('a', '/missing') }, ['a']), node('c', 'echo', {}, ['b'])])
  assert.deepEqual(statuses(result), ['succeeded', 'failed', 'blocked'])
})

test('scope restrictions, guard denials and approval requests remain authoritative', async t => {
  const { ctx, register, call, agent } = await setup(t)
  let executions = 0
  register('echo', async () => { executions++; return null })
  let scope
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const unrestrict = scope.ctx.tools.restrict({ deny: ['echo'] })
  assert.equal((await call([node('a')])).isError, true)
  unrestrict()
  const unguard = ctx.tools.guard(exec => exec.name === 'echo' ? 'Denied by fixture guard' : undefined)
  assert.deepEqual(statuses(await call([node('a')])), ['failed'])
  unguard()
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'echo' ? { kind: 'ask', reason: 'Needs approval' } : next())
  assert.deepEqual(statuses(await call([node('a')])), ['failed'])
  assert.equal(executions, 0)
})

test('nested call retains agent, root id and parent token and forwards extra context', async t => {
  const { ctx, register, call, agent } = await setup(t)
  const extra = createUserMessage({ kind: 'test' }, [{ type: 'text', text: 'deferred' }])
  register('echo', async (_args, exec) => {
    assert.equal(exec.agent, agent)
    assert.equal(exec.rootCallId, 'root')
    assert.ok(exec.parent)
    assert.match(exec.callId, /:dag:/u)
    exec.deferContext(extra)
    return 'ok'
  })
  const result = await call([node('a')])
  assert.deepEqual(result.additionalContexts, [extra])
  ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'echo'
    ? { kind: 'accept', content: [{ type: 'text', text: 'redacted' }] } : next())
  const redacted = await call([node('a')])
  assert.equal(JSON.parse(redacted.value.nodes[0].output)[0].text, 'redacted')
})

test('turn completion propagates and stops later node dispatch', async t => {
  const { register, call } = await setup(t, { maxConcurrency: 1 })
  register('done', async (_args, exec) => { exec.concludeTurn(); return 'done' }, false)
  register('echo', async () => 'unexpected')
  const result = await call([node('a', 'done'), node('b')])
  assert.equal(result.concludesTurn, true)
  assert.deepEqual(statuses(result), ['succeeded', 'skipped'])
})

test('indirect recursion through another tool fails without creating another graph', async t => {
  const { ctx, register, call } = await setup(t)
  register('reenter', async (_args, exec) => {
    const result = await ctx.tools.execute({ ...exec, parent: exec.token, name: 'dag_execute',
      callId: ToolCallId('recursive'), arguments: { nodes: [node('loop', 'reenter')] } })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /Nested DAG/u)
    return 'recursion denied'
  })
  assert.deepEqual(statuses(await call([node('a', 'reenter')])), ['succeeded'])
})

test('timeout drains running work and cancels queued nodes', async t => {
  const { register, call } = await setup(t, { timeoutMs: 25, maxConcurrency: 1 })
  let settled = false
  register('slow', async (_args, exec) => {
    try { await delay(5000, null, { signal: exec.signal }); return null }
    finally { await delay(10); settled = true }
  })
  const result = await call([node('a', 'slow'), node('b', 'slow')])
  assert.equal(settled, true)
  assert.equal(result.value.timedOut, true)
  assert.deepEqual(statuses(result), ['cancelled', 'cancelled'])
})

test('caller cancellation waits for tool cleanup and prevents subsequent dispatch', async t => {
  const { register, call } = await setup(t, { maxConcurrency: 1 })
  const controller = new AbortController()
  let settled = false
  let calls = 0
  register('slow', async (_args, exec) => {
    calls++
    controller.abort()
    try { await delay(5000, null, { signal: exec.signal }); return null }
    finally { await delay(10); settled = true }
  })
  const result = await call([node('a', 'slow'), node('b', 'slow')], { signal: controller.signal })
  assert.equal(result.isError, true)
  assert.equal(settled, true)
  assert.equal(calls, 1)
})

test('disposal aborts and drains running graphs', async t => {
  const { fork, register, call } = await setup(t)
  let started
  const ready = new Promise(resolve => { started = resolve })
  let settled = false
  register('slow', async (_args, exec) => {
    started()
    try { await delay(5000, null, { signal: exec.signal }); return null }
    finally { settled = true }
  })
  const run = call([node('a', 'slow')])
  await ready
  await fork.dispose()
  await run
  assert.equal(settled, true)
})

test('configuration bounds, JSON pointers, reference syntax and output limits', async t => {
  assert.equal(dag.Config({}).maxConcurrency, 4)
  for (const config of [{ maxConcurrency: 0 }, { maxNodes: 129 }, { timeoutMs: -1 }]) assert.throws(() => dag.Config(config))
  assert.throws(() => validateGraph([node('a')], 1, 2))
  assert.throws(() => validateGraph([node('a', 'echo', { x: { $dagRef: { node: 'b', pointer: '/~2' } } })], 32, 10000))
  const args = resolveArguments(node('b', 'echo', { x: ref('a', '/a~1b/~0x') }), new Map([['a', { 'a/b': { '~x': 7 } }]]))
  assert.deepEqual(args, { x: 7 })
  assert.throws(() => resolveArguments(node('b', 'echo', { x: ref('a', '/toString') }), new Map([['a', {}]])))
  const { register, call } = await setup(t, { maxNodeOutputChars: 128 })
  register('echo', async () => 'x'.repeat(200))
  const result = await call([node('a')])
  assert.equal(result.value.nodes[0].truncated, true)
  assert.equal(result.value.nodes[0].output.length, 128)
})
