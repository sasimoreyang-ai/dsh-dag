/**
 * `dag-compiler`: LLMCompiler as the agent, not as a tool.
 *
 * The `dag_execute` tool in this package is the *tool* arm: the native loop
 * decides when to hand a graph to the plugin. This plugin is the *compiler*
 * arm, ported from the dsh ParallelQA demo (`dsh-demo/plugin-dag.mjs`): it hooks
 * the public `llm/stream` waterfall and, when the request is the outer loop's
 * own call, replaces the model stream with the compiler itself — planner, task
 * fetching unit, executor, joiner — and yields the joiner's answer as the
 * assistant message.
 *
 * The turn therefore runs with zero real outer-loop model calls, while session
 * logging, turn lifecycle, permission and approval pipelines, and tool result
 * policies stay native harness machinery.
 *
 * Request discrimination: the reference demo relied on a structural heuristic
 * (`system === undefined` plus a leading system-role message) because the host
 * version it targeted had no marker. This host stamps loop-owned requests, so
 * `isAgentLoopRequest` is the default and strictest signal; the heuristic
 * remains available for A/B reproduction of the reference.
 *
 * @module @sasimoreyang-ai/dsh-dag/compiler
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config, type Config as CompilerConfig } from './config.js'
import {
  buildArguments, callModel, observationOf, runCompiler, CompilerLlmError,
  type CompilerDeps, type CompilerMetrics,
} from './engine.js'

export { Config }
export { runCompiler, callModel, buildArguments, observationOf, CompilerLlmError }
export type { CompilerMetrics, CompilerDeps, CompilerSettings } from './engine.js'
export type { ToolSpec } from './prompts.js'
export { defaultTools, plannerSystemPrompt, JOINER_PROMPT, END_OF_PLAN } from './prompts.js'
export {
  parseArgs, dependenciesOf, parsePlan, substitute, stringifyArgs, scheduleWaves, parseJoinerOutput,
} from './plan.js'

/** Cordis plugin name shown by loader diagnostics. */
export const name = 'dag-compiler'
/** The tool registry (executor) and the model runtime (planner/joiner and the interposed stream). */
export const inject = ['tools', 'llm']

// Covers indirect recursion: a compiled tool that itself triggers a model call
// must not be compiled again.
const compiling = new AsyncLocalStorage<boolean>()

/** The subset of one request message this module reads. */
interface RequestLike {
  role?: string
  content?: unknown
  source?: { kind?: string }
}

/**
 * The reference demo's structural test for "this is the outer loop's call".
 * @param options - the request under the waterfall.
 * @returns whether the request looks loop-built.
 */
export function isLoopRequestByHeuristic(options: GenerateOptions): boolean {
  const messages = (options.messages ?? []) as readonly RequestLike[]
  return options.system === undefined
    && messages.length > 0
    && messages[0]?.role === 'system'
    && messages.some(message => message.role === 'user')
}

/**
 * The question text of one loop request: the last user message that is actual
 * user input. The loop also projects machine-owned user messages into the
 * history (runtime-context snapshots, subagent settlements); those carry their
 * own `source.kind` and are skipped.
 * @param options - the request under the waterfall.
 * @returns the question, or undefined when no user text is present.
 */
export function questionOf(options: GenerateOptions): string | undefined {
  const messages = ((options.messages ?? []) as readonly RequestLike[]).filter(message => message.role === 'user')
  const actual = messages.filter(message => message.source?.kind === 'user')
  const last = (actual.length > 0 ? actual : messages.filter(message => message.source?.kind !== 'runtime-context')).at(-1)
  if (last === undefined) return undefined
  const blocks = Array.isArray(last.content) ? last.content as readonly { type?: string, text?: string }[] : [{ type: 'text', text: String(last.content ?? '') }]
  const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * Resolve the live agent that owns one loop request.
 *
 * The waterfall hands over the request, not the agent; the agent registry is
 * keyed by the same session id the loop stamps on the request, so the compiler
 * can still dispatch agent-scoped tools (and inherit their permissions) instead
 * of only reaching global ones.
 * @param ctx - plugin context.
 * @param sessionId - the request's session identity.
 * @returns the live agent, or undefined when the registry is absent or idle.
 */
function resolveAgent(ctx: Context, sessionId: GenerateOptions['sessionId']): Agent | undefined {
  if (sessionId === undefined) return undefined
  try {
    const registry = (ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents
    return registry?.get(sessionId)
  } catch {
    // A host without the agent service, or a dispose race: run without an agent.
    return undefined
  }
}

/**
 * Mount the compiler over the outer loop's model calls.
 * @param ctx - plugin context exposing the tool registry and the model runtime.
 * @param config - route, bounds, vocabulary, and diagnostics.
 */
export function apply(ctx: Context, config: CompilerConfig): void {
  const shutdown = new AbortController()
  ctx.effect(() => () => { shutdown.abort(new Error('DAG compiler plugin disposed.')) }, 'dag-compiler: cancel in-flight compilations')

  const trace = (event: string, data: Record<string, unknown>): void => {
    if (!config.trace) return
    // Observability must never alter execution.
    try { ctx.logger.info(`dag.compiler.trace ${JSON.stringify({ version: 1, time: new Date().toISOString(), event, ...data })}`) }
    catch { /* Host logging may already be disposed during shutdown. */ }
  }

  const takeOver = (options: GenerateOptions): boolean => {
    switch (config.detect) {
      case 'marker': return isAgentLoopRequest(options)
      case 'heuristic': return isLoopRequestByHeuristic(options)
      default: return isAgentLoopRequest(options) || isLoopRequestByHeuristic(options)
    }
  }

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    // Our own planner/joiner calls re-enter this waterfall; never compile those.
    if (compiling.getStore()) return next()
    if (!takeOver(options)) return next()
    const question = questionOf(options)
    if (question === undefined) return next()

    return (async function* compile(): AsyncGenerator<StreamChunk> {
      const signal = options.signal ?? new AbortController().signal
      const agent = resolveAgent(ctx, options.sessionId)
      const deps: CompilerDeps = {
        stream: call => ctx.llm.stream(call),
        // This host dispatches a batch of model tool calls; one plan task is a
        // batch of one, so the engine's per-task executor contract is unchanged.
        execute: async input => {
          const batch = await ctx.tools.execute({
            calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
            signal: input.signal,
            ...(input.agent === undefined ? {} : { agent: input.agent }),
          })
          const settled = batch.results[0]?.result
          return settled ?? {
            isError: true,
            error: { message: `${input.name} settled without a result` },
            content: [{ type: 'text', text: `${input.name} settled without a result` }],
          }
        },
        ...(agent === undefined ? {} : { agent }),
        trace,
      }
      let metrics: CompilerMetrics
      try {
        metrics = await compiling.run(true, () => runCompiler(deps, config, question, signal))
      } catch (error) {
        // Surface the failure as a failed model call instead of failing the turn
        // mutely: this host has no successful finish reason for it.
        trace('compile-error', { message: error instanceof Error ? error.message : String(error) })
        throw error
      }
      const answer = metrics.answer !== '' ? metrics.answer : metrics.answerTolerant
      trace('compile-end', {
        answer, tasks: metrics.planTasks, waves: metrics.planWaves, maxWidth: metrics.maxWidth,
        replans: metrics.replans, llmCalls: metrics.llmCalls,
        plannerMs: metrics.plannerMs, executeMs: metrics.executeMs, joinerMs: metrics.joinerMs,
      })
      // The virtual assistant message, exactly the reference demo's sequence:
      // answer text, the engine's own planner+joiner usage (tool-internal usage
      // is reported by the tool plugins' own sinks), and a clean stop. This host
      // does not require block markers around a text delta.
      yield { type: 'text-delta', index: 0, text: answer }
      yield {
        type: 'usage',
        usage: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          ...(metrics.totalTokens > 0 ? { totalTokens: metrics.totalTokens } : {}),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
}
