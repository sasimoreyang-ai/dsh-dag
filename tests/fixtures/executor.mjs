/**
 * Test fixture: the minimal tool executor this host needs before it will
 * dispatch anything. A real deployment contributes one from the agent loop;
 * these tests load the public pipeline directly so graph and compiler dispatch
 * exercise the same policy/cancellation stages the loop would use.
 */

import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'

/**
 * Install a single-executor over the public pipeline.
 * @param ctx - the test context, after the tools plugin is loaded.
 * @param maxParallel - batch concurrency the executor reports.
 * @returns the pipeline, for focused assertions.
 */
export function loadExecutor(ctx, maxParallel = 8) {
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: () => ({ schemas: [], knownNames: [] }),
    execute: input => executeToolBatch(input, pipeline, () => maxParallel),
  })
  return pipeline
}

/**
 * Dispatch one model-shaped tool call and return its settled result.
 * @param ctx - the test context.
 * @param name - tool name.
 * @param args - plain arguments, serialized the way a model response carries them.
 * @param options - call id, agent, and cancellation.
 * @returns the settled tool result.
 */
export async function callTool(ctx, name, args, options = {}) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: options.callId ?? 'call-fixture', name, arguments: JSON.stringify(args) }],
    signal: options.signal ?? new AbortController().signal,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  })
  const settled = batch.results[0]
  if (settled === undefined) throw new Error(`${name} settled without a result`)
  return settled.result
}
