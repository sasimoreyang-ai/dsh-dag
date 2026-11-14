#!/usr/bin/env node
/**
 * Manual smoke check for the compile-style orchestration core.
 *
 * Runs two scripted scenarios with stub callbacks (no model, no DSH runtime):
 *   1. replan once, then finish
 *   2. a Finish that the net-diff gate rejects, forcing another round
 *
 * Usage: npm run smoke
 */
import assert from 'node:assert/strict'
import { compile, positionalNodes } from '../lib/compiler/index.js'

const tools = new Set(['read', 'edit'])
const plannerTools = [{ name: 'read', description: 'read a file' }, { name: 'edit', description: 'edit a file' }]

function scripted(plans, decisions, extra = {}) {
  const state = { plans: 0, joins: 0 }
  return {
    state,
    callbacks: {
      async plan() { return { text: plans[Math.min(state.plans++, plans.length - 1)], tokens: 10 } },
      async join() { return { text: decisions[Math.min(state.joins++, decisions.length - 1)], tokens: 10 } },
      async execute(nodes) {
        return nodes.map(node => ({ id: node.id, tool: node.tool, status: 'succeeded', durationMs: 1, output: 'ok' }))
      },
      toNodes: positionalNodes('command'),
      ...extra.callbacks,
    },
  }
}

function report(label, result) {
  console.log(`\n${label}`)
  console.log(`  status   ${result.status}`)
  console.log(`  tokens   ${result.tokens}`)
  for (const round of result.rounds) {
    const statuses = Object.entries(round.statuses).map(([key, value]) => `${key}=${value}`).join(' ') || '-'
    console.log(`  round ${round.round}  ${round.decision.padEnd(12)} tasks=${round.taskCount}  ${statuses}  ${round.detail}`)
  }
}

// Scenario 1: repLAN -> finish.
const first = scripted(
  ['1. read("a")\n2. join()', '1. edit("b")\n2. join()'],
  ['Action: Replan(apply the edit)', 'Action: Finish(applied)'],
)
const converged = await compile({ question: 'demo', knownTools: tools, plannerTools }, first.callbacks)
report('scenario 1: replan then finish', converged)
assert.equal(converged.status, 'finished')
assert.deepEqual(converged.rounds.map(round => round.decision), ['replan', 'finish'])

// Scenario 2: the net-diff gate rejects the first Finish.
let probes = 0
const gated = scripted(
  ['1. read("a")\n2. join()', '1. edit("b")\n2. join()'],
  ['Action: Finish(nothing done)', 'Action: Finish(applied)'],
  { callbacks: { workingTreeChanged: async () => { probes += 1; return probes > 1 } } },
)
const rejected = await compile({ question: 'demo', knownTools: tools, plannerTools }, gated.callbacks)
report('scenario 2: net-diff gate rejects the first finish', rejected)
assert.equal(rejected.status, 'finished')
assert.deepEqual(rejected.rounds.map(round => round.decision), ['gated-replan', 'finish'])

console.log('\nsmoke ok: 2 scenarios, both converged as scripted.')
