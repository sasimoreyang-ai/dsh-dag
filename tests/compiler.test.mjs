import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compile, joinerPrompt, parseArguments, parseJoiner, parsePlan, plannerSystemPrompt,
  positionalNodes, referencesOf, substituteReferences,
} from '../lib/compiler/index.js'

const tools = new Set(['read', 'grep', 'edit'])

test('parseArguments accepts literals only and rejects expressions', () => {
  assert.deepEqual(parseArguments('"README.md", 80'), ['README.md', 80])
  assert.deepEqual(parseArguments('"a\\"b", \'c\', [1, 2], true, null'), ['a"b', 'c', [1, 2], true, null])
  assert.deepEqual(parseArguments(''), [])
  assert.throws(() => parseArguments('process.exit(1)'), /Unsupported plan argument/u)
  assert.throws(() => parseArguments('"unterminated'), /Unterminated string/u)
  assert.throws(() => parseArguments('[1, 2'), /Unterminated array/u)
})

test('referencesOf reads $n and ${n} once, in first-seen order', () => {
  assert.deepEqual(referencesOf(['a $2 b $1 c', ['${3}'], 7]), [2, 1, 3])
  assert.deepEqual(referencesOf(['$1 and $1']), [1])
  assert.deepEqual(referencesOf([null, true, 4]), [])
})

test('parsePlan builds tasks, dependencies and the join sentinel', () => {
  const text = [
    'Thought: look first',
    '1. grep("get_form", "admin")',
    '2. read("$1", 20)',
    'Thought: now decide',
    '3. join()<END_OF_PLAN>',
    '4. edit("never parsed")',
  ].join('\n')
  const plan = parsePlan(text, { knownTools: tools, maxTasks: 10 })
  assert.equal(plan.joinSeen, true)
  assert.equal(plan.empty, false)
  assert.equal(plan.tasks.length, 2)
  assert.deepEqual(plan.tasks[0], {
    id: 'n1', tool: 'grep', args: ['get_form', 'admin'], dependsOn: [], thought: 'look first',
  })
  assert.deepEqual(plan.tasks[1].dependsOn, ['n1'])
  // A Thought annotates only the task that immediately follows it.
  assert.equal(plan.tasks[1].thought, '')
  assert.deepEqual(plan.thoughts, ['look first', 'now decide'])
})

test('parsePlan tolerates missing numbers, ignores unknown tools, and caps tasks', () => {
  const unnumbered = parsePlan('read("a")\nunknown_tool("b")\nedit("c")',
    { knownTools: tools, maxTasks: 10 })
  assert.deepEqual(unnumbered.tasks.map(task => task.tool), ['read', 'edit'])
  assert.deepEqual(unnumbered.tasks.map(task => task.id), ['n1', 'n2'])

  const capped = parsePlan('1. read("a")\n2. read("b")\n3. read("c")', { knownTools: tools, maxTasks: 2 })
  assert.equal(capped.tasks.length, 2)

  const empty = parsePlan('I will think about it later.', { knownTools: tools, maxTasks: 10 })
  assert.equal(empty.empty, true)
  assert.equal(empty.joinSeen, false)
})

test('parsePlan rejects duplicate line numbers and renders structured arguments', () => {
  assert.throws(() => parsePlan('1. read("a")\n1. read("b")', { knownTools: tools, maxTasks: 10 }),
    /Duplicate plan line number 1/u)

  const { callbacks } = harness(['1. read(["a", "b"])'], ['Action: Finish(done)'])
  return compile({ question: 'q', knownTools: tools, plannerTools: [] }, callbacks)
})

test('substituteReferences replaces known ids and keeps unknown placeholders', () => {
  assert.deepEqual(substituteReferences(['path $1', ['$2']], new Map([['n1', 'x.py']])),
    ['path x.py', ['$2']])
})

test('parseJoiner handles both actions, a missing prefix and unknown output', () => {
  assert.deepEqual(parseJoiner('Thought: done\nAction: Finish(fixed it)'),
    { kind: 'finish', summary: 'fixed it', thought: 'done' })
  assert.deepEqual(parseJoiner('Replan(read the file first)'),
    { kind: 'replan', reason: 'read the file first', thought: '' })
  assert.equal(parseJoiner('I am not sure.').kind, 'unknown')
})

test('prompt builders include the declared tools, the join tool and the joiner rules', () => {
  const system = plannerSystemPrompt({ tools: [{ name: 'read', description: 'read files' }] })
  assert.match(system, /1\. read\(\.\.\.\): read files/u)
  assert.match(system, /2\. join\(\)/u)
  assert.match(system, /<END_OF_PLAN>/u)
  assert.match(joinerPrompt('q', 'pad'), /Finish\(summary\)/u)
})

function harness(plans, decisions, overrides = {}) {
  const seen = { plans: [], joins: 0, executed: [], contexts: [] }
  const callbacks = {
    async plan(request, context) {
      seen.plans.push({ request, context })
      return { text: plans[Math.min(seen.plans.length - 1, plans.length - 1)], tokens: 10 }
    },
    async join(prompt) {
      seen.joins += 1
      return { text: decisions[Math.min(seen.joins - 1, decisions.length - 1)], tokens: 10 }
    },
    async execute(nodes) {
      seen.executed.push(nodes)
      return nodes.map(node => ({ id: node.id, tool: node.tool, status: 'succeeded',
        durationMs: 1, output: 'ok' }))
    },
    toNodes: positionalNodes('command'),
    ...overrides,
  }
  return { callbacks, seen }
}

test('compile replans, then finishes, and reports per-round statuses', async () => {
  const { callbacks, seen } = harness(
    ['1. read("a")\n2. join()', '1. edit("b")\n2. join()'],
    ['Action: Replan(apply the edit)', 'Action: Finish(applied)'],
  )
  const result = await compile({
    question: 'fix it',
    knownTools: tools,
    plannerTools: [{ name: 'read', description: 'read' }, { name: 'edit', description: 'edit' }],
  }, callbacks)

  assert.equal(result.status, 'finished')
  assert.equal(result.summary, 'applied')
  assert.equal(result.rounds.length, 2)
  assert.equal(result.rounds[0].decision, 'replan')
  assert.deepEqual(result.rounds[1].statuses, { succeeded: 1 })
  assert.equal(seen.executed.length, 2)
  assert.match(seen.plans[1].request.user, /Previous Plan:/u)
})

test('compile rejects a finish when the working tree is unchanged', async () => {
  const { callbacks, seen } = harness(
    ['1. read("a")\n2. join()', '1. edit("b")\n2. join()'],
    ['Action: Finish(nothing done)', 'Action: Finish(applied)'],
    { workingTreeChanged: async () => seen.joins > 1 },
  )
  const result = await compile({ question: 'q', knownTools: tools, plannerTools: [] }, callbacks)
  assert.equal(result.status, 'finished')
  assert.equal(result.rounds[0].decision, 'gated-replan')
  assert.equal(result.rounds[1].decision, 'finish')
})

test('compile stops on budget, empty plans and round exhaustion', async () => {
  const budget = harness(['1. read("a")'], ['Action: Replan(again)'])
  const spent = await compile({ question: 'q', knownTools: tools, plannerTools: [], tokenBudget: 15 }, budget.callbacks)
  assert.equal(spent.status, 'budget')

  const blank = harness(['nothing to do'], ['Action: Replan(x)'])
  const empty = await compile({ question: 'q', knownTools: tools, plannerTools: [] }, blank.callbacks)
  assert.equal(empty.status, 'empty-plan')
  assert.equal(empty.rounds.length, 2)

  const looping = harness(['1. read("a")'], ['Action: Replan(again)'])
  const capped = await compile({ question: 'q', knownTools: tools, plannerTools: [], maxRounds: 3 }, looping.callbacks)
  assert.equal(capped.status, 'exhausted')
  assert.equal(capped.rounds.length, 3)
})

test('compile compacts old rounds out of the replan context', async () => {
  const { callbacks, seen } = harness(
    ['1. read("a")', '1. read("b")', '1. read("c")'],
    ['Action: Replan(one)', 'Action: Replan(two)', 'Action: Finish(done)'],
  )
  await compile({ question: 'q', knownTools: tools, plannerTools: [], keepRecentRounds: 1 }, callbacks)
  assert.match(seen.plans[2].request.user, /Earlier rounds: 1 round\(s\)/u)
  assert.doesNotMatch(seen.plans[2].request.user, /read\("a"\)/u)
})

test('positionalNodes refuses multi-argument tasks without a custom binder', () => {
  const bind = positionalNodes('command')
  assert.deepEqual(bind([{ id: 'n1', tool: 'read', args: ['a'], dependsOn: [], thought: '' }]),
    [{ id: 'n1', tool: 'read', arguments: { command: 'a' }, dependsOn: [] }])
  assert.throws(() => bind([{ id: 'n1', tool: 'read', args: ['a', 'b'], dependsOn: [], thought: '' }]),
    /custom binder/u)
})
