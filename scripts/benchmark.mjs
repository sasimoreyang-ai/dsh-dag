import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as dag from '../lib/index.js'

// Controlled scheduler benchmark. Each branch has two sequential 50 ms tools.
// The fixture excludes LLM latency and makes no claim about native DSH speedup.
async function measure(concurrency) {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(dag, { maxConcurrency: concurrency, trace: false })
    ctx.tools.register({ name: 'wait_fixture', description: '', parameters: { type: 'object' },
      output: { schema: {}, render: () => [] }, isConcurrencySafe: () => true,
      async execute(_args, exec) { await delay(50, null, { signal: exec.signal }); return 'ok' } })
    const nodes = []
    for (let branch = 0; branch < 4; branch++) {
      nodes.push({ id: `a${branch}`, tool: 'wait_fixture', arguments: {} })
      nodes.push({ id: `b${branch}`, tool: 'wait_fixture', arguments: {}, dependsOn: [`a${branch}`] })
    }
    const start = performance.now()
    const result = await ctx.tools.execute({ name: 'dag_execute', callId: ToolCallId('bench'),
      agent: { id: 'benchmark' }, arguments: { nodes }, signal: new AbortController().signal })
    if (result.isError || result.value.status !== 'succeeded') throw new Error(JSON.stringify(result))
    return Math.round(performance.now() - start)
  } finally { await ctx.fiber.dispose() }
}

const serial = []
const parallel = []
for (let repeat = 0; repeat < 3; repeat++) {
  serial.push(await measure(1))
  parallel.push(await measure(4))
}
console.log(JSON.stringify({ benchmark: 'eight synthetic 50ms tools, four two-stage branches', serialMs: serial, concurrency4Ms: parallel }, null, 2))
