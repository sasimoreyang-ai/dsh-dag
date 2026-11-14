import { performance } from 'node:perf_hooks'
import { resolveArguments, type DagNode, type Json } from './graph.js'

export type Status = 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'skipped'
export type NodeResult = {
  id: string
  tool: string
  status: Status
  durationMs: number
  output?: string
  truncated?: boolean
  error?: string
}

export interface Outcome {
  ok: boolean
  value?: Json
  output: string
  error?: string
  cancelled?: boolean
  concludesTurn?: boolean
}

export interface SchedulerOptions {
  concurrency: number
  maxNodeOutputChars: number
  signal: AbortSignal
  failurePolicy: 'continue' | 'stop'
  parallel(node: DagNode, args: Record<string, Json>): boolean
  execute(node: DagNode, args: Record<string, Json>): Promise<Outcome>
  trace(event: string, node: DagNode, result?: NodeResult): void
}

/** Ready nodes launch as soon as capacity is available. Exclusive calls form barriers. */
export async function runGraph(nodes: DagNode[], options: SchedulerOptions): Promise<NodeResult[]> {
  const pending = new Set(nodes.map(node => node.id))
  const results = new Map<string, NodeResult>()
  const values = new Map<string, Json>()
  const active = new Map<string, Promise<void>>()
  let exclusive = false
  let stopped = false

  function finish(node: DagNode, result: NodeResult): void {
    results.set(node.id, result)
    pending.delete(node.id)
    options.trace('node-end', node, result)
  }

  async function dispatch(node: DagNode, args: Record<string, Json>, isExclusive: boolean): Promise<void> {
    const start = performance.now()
    options.trace('node-start', node)
    try {
      const outcome = await options.execute(node, args)
      const status = outcome.cancelled ? 'cancelled' : outcome.ok ? 'succeeded' : 'failed'
      const result: NodeResult = {
        id: node.id, tool: node.tool, status,
        durationMs: Math.round(performance.now() - start),
        output: outcome.output.slice(0, options.maxNodeOutputChars),
        truncated: outcome.output.length > options.maxNodeOutputChars,
      }
      if (outcome.error) result.error = outcome.error.slice(0, options.maxNodeOutputChars)
      if (outcome.ok) values.set(node.id, outcome.value ?? null)
      if (outcome.concludesTurn || (!outcome.ok && options.failurePolicy === 'stop')) stopped = true
      finish(node, result)
    } catch (error) {
      finish(node, {
        id: node.id, tool: node.tool, status: options.signal.aborted ? 'cancelled' : 'failed',
        durationMs: Math.round(performance.now() - start),
        error: String(error).slice(0, options.maxNodeOutputChars),
      })
      if (options.failurePolicy === 'stop') stopped = true
    } finally {
      active.delete(node.id)
      if (isExclusive) exclusive = false
    }
  }

  while (pending.size || active.size) {
    let progressed = false
    for (const node of nodes) {
      if (!pending.has(node.id)) continue
      const dependencyFailed = node.dependsOn.some(id => results.has(id) && results.get(id)!.status !== 'succeeded')
      if (options.signal.aborted || dependencyFailed || stopped) {
        const status = options.signal.aborted ? 'cancelled' : dependencyFailed ? 'blocked' : 'skipped'
        finish(node, { id: node.id, tool: node.tool, status, durationMs: 0 })
        progressed = true
        continue
      }
      if (!node.dependsOn.every(id => results.get(id)?.status === 'succeeded')) continue
      if (exclusive || active.size >= options.concurrency) break
      let args: Record<string, Json>
      let parallel: boolean
      try {
        args = resolveArguments(node, values)
        parallel = options.parallel(node, args)
      } catch (error) {
        finish(node, { id: node.id, tool: node.tool, status: 'failed', durationMs: 0,
          error: String(error).slice(0, options.maxNodeOutputChars) })
        if (options.failurePolicy === 'stop') stopped = true
        progressed = true
        continue
      }
      // Stop scanning at an exclusive ready node, so later reads cannot starve it.
      if (!parallel && active.size) break
      pending.delete(node.id)
      exclusive = !parallel
      // Defer the body one microtask so even a synchronous failure can safely remove itself.
      active.set(node.id, Promise.resolve().then(() => dispatch(node, args, !parallel)))
      progressed = true
      if (exclusive) break
    }
    if (active.size) await Promise.race(active.values())
    else if (pending.size && !progressed) throw new Error('DAG scheduler made no progress.')
  }
  return nodes.map(node => results.get(node.id)!)
}
