import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, validateJsonSchemaValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import { mapArguments, validateGraph, type DagNode, type Json } from './graph.js'
import { runGraph, type NodeResult } from './scheduler.js'

export { Config }
export const name = 'tool-dag'
export const inject = ['tools']

// Covers indirect recursion through another tool, with independent async caller chains.
const runningDag = new AsyncLocalStorage<boolean>()

export function apply(ctx: Context, config: Config): void {
  const shutdown = new AbortController()
  const active = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    shutdown.abort(new Error('DAG plugin disposed.'))
    await Promise.allSettled(active)
  }, 'dag: cancel and drain active runs')

  function trace(data: Record<string, unknown>): void {
    if (!config.trace) return
    // Observability must never alter execution or prevent in-flight work from settling.
    try { ctx.logger.info(`dag.trace ${JSON.stringify({ version: 1, time: new Date().toISOString(), ...data })}`) }
    catch { /* Host logging may already be disposed during shutdown. */ }
  }

  async function executeDag(nodesInput: unknown, failurePolicy: 'continue' | 'stop', exec: ToolRunContext) {
    if (!exec.agent) throw new Error('dag_execute requires a calling DSH agent.')
    const nodes = validateGraph(nodesInput, config.maxNodes, config.maxInputChars)
    // Check all visible definitions and literal arguments before the first dispatch.
    for (const node of nodes) {
      if (node.tool === 'dag_execute') throw new Error('Nested DAG execution is disabled.')
      const definition = ctx.tools.get(node.tool, exec.agent)
      if (!definition) throw new Error(`Tool ${node.tool} is unavailable to this agent.`)
      let hasReferences = false
      mapArguments(node.arguments, () => { hasReferences = true; return null })
      if (!hasReferences) {
        const errors = validateJsonSchemaValue(definition.parameters, node.arguments)
        if (errors.length) throw new Error(`Invalid arguments for ${node.id}: ${errors.join(', ')}`)
      }
    }

    const runId = randomUUID()
    const started = performance.now()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('DAG deadline exceeded.')), config.timeoutMs)
    timer.unref()
    const signal = AbortSignal.any([exec.signal, shutdown.signal, deadline.signal])
    const correlation = { runId, sessionId: exec.agent.id, rootCallId: exec.rootCallId, callId: exec.callId }
    const input = (node: DagNode, args: Record<string, Json>) => ({
      callId: ToolCallId(`${exec.callId}:dag:${runId}:${node.id}`),
      rootCallId: exec.rootCallId,
      parent: exec.token,
      agent: exec.agent,
      name: node.tool,
      arguments: args,
      signal,
    })
    trace({ ...correlation, event: 'run-start', nodeCount: nodes.length, maxConcurrency: config.maxConcurrency })
    try {
      const results = await runGraph(nodes, {
        signal,
        concurrency: config.maxConcurrency,
        failurePolicy,
        maxNodeOutputChars: config.maxNodeOutputChars,
        parallel: (node, args) => ctx.tools.executionMode(input(node, args)).kind === 'parallel',
        async execute(node, args) {
          const result = await ctx.tools.execute(input(node, args))
          for (const context of result.additionalContexts ?? []) exec.deferContext(context)
          if (result.concludesTurn) exec.concludeTurn()
          // Preserve the policy-processed model projection in the returned report.
          // Canonical values remain private to dependency resolution, as in DSH's PTC transport.
          if (result.isError) return {
            ok: false,
            cancelled: signal.aborted || ['ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(result.error.info?.code ?? ''),
            output: JSON.stringify(result.content),
            // Raw failures can contain details omitted by DSH's model projection.
            error: result.error.info?.code ?? 'TOOL_FAILED',
          }
          return { ok: true, value: result.value, output: JSON.stringify(result.content), concludesTurn: result.concludesTurn }
        },
        trace(event: string, node: DagNode, result?: NodeResult) {
          trace({ ...correlation, event, nodeId: node.id, tool: node.tool,
            subCallId: input(node, {}).callId,
            ...(result ? { status: result.status, durationMs: result.durationMs } : {}) })
        },
      })
      const status = signal.aborted ? 'cancelled'
        : results.every(result => result.status === 'succeeded') ? 'succeeded' : 'partial'
      const report = { runId, status, durationMs: Math.round(performance.now() - started),
        timedOut: deadline.signal.aborted, nodes: results }
      trace({ ...correlation, event: 'run-end', status, timedOut: report.timedOut, durationMs: report.durationMs })
      return report
    } finally {
      clearTimeout(timer)
    }
  }

  ctx.tools.register(defineTool({
    name: 'dag_execute',
    description: 'Execute a dependency graph of tools available to this agent. Plan explicit nodes and dependsOn edges. '
      + 'Use for known multi-stage tool work whose independent nodes can overlap. '
      + 'Use {"$dagRef":{"node":"upstream-id","pointer":"/field"}} inside arguments to reference a canonical result '
      + '(empty pointer selects the whole value). Every referenced node must be in dependsOn. '
      + 'Only tools declaring concurrency safety run together. Other tools run exclusively. '
      + 'Each call retains normal permissions and approvals. Failed dependencies are blocked. '
      + 'Inspect returned node statuses before continuing. Completed operations may have side effects. '
      + 'Plan only currently known work, then use another call if later results require a new plan.',
    parameters: {
      nodes: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true, description: 'Unique id, 1-64 letters, digits, _ or -.' },
          tool: { type: 'string', required: true, description: 'An existing tool visible to this agent.' },
          arguments: { type: 'object', additionalProperties: true, required: true },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      } },
      failurePolicy: { type: 'string', enum: ['continue', 'stop'],
        description: 'Default continue runs independent branches. stop skips queued work after failure and drains running calls.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (runningDag.getStore()) throw new Error('Nested DAG execution is disabled.')
      if (shutdown.signal.aborted) throw new Error('DAG plugin is shutting down.')
      const promise = runningDag.run(true, () => executeDag(args.nodes, args.failurePolicy ?? 'continue', exec))
      active.add(promise)
      try { return await promise }
      finally { active.delete(promise) }
    },
    // The outer operation is exclusive. All internal concurrency is scheduled above.
    presentCall: args => ({ card: 'generic', title: `DAG · ${args.nodes.length} nodes` }),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
  }))
}
