import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { callTool, loadExecutor } from './fixtures/executor.mjs'
import * as dag from '../lib/index.js'

test('trace correlates each dispatch and terminal status without recording argument payloads', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const records = []
  ctx.logger.exporter({ export(message) {
    const text = message.args[0]
    if (typeof text === 'string' && text.startsWith('dag.trace ')) records.push(JSON.parse(text.slice(10)))
  } })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  loadExecutor(ctx)
  await ctx.plugin(dag)
  ctx.tools.register({ name: 'fixture', description: '', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] }, execute: async () => 'SECRET-RESULT' })
  const result = await callTool(ctx, 'dag_execute',
    { nodes: [{ id: 'one', tool: 'fixture', arguments: { secret: 'SECRET-INPUT' } }] },
    { callId: ToolCallId('trace-root'), agent: { id: 'session-1' } })
  assert.equal(result.isError, false)
  assert.deepEqual(records.map(row => row.event), ['run-start', 'node-start', 'node-end', 'run-end'])
  assert.ok(records.every(row => row.runId === result.value.runId && row.sessionId === 'session-1'))
  assert.equal(records[1].subCallId, records[2].subCallId)
  assert.equal(records[2].status, 'succeeded')
  assert.equal(JSON.stringify(records).includes('SECRET'), false)
})
