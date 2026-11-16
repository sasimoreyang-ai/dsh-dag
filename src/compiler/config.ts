import z from '@deepseek-ai/schemastery'
import { defaultTools, type ToolSpec } from './prompts.js'

/** How tightly a loop request must match before the compiler takes over. */
export type DetectMode =
  /** Only requests the agent loop itself marked (`isAgentLoopRequest`). Safest. */
  | 'marker'
  /** Only the reference demo's structural heuristic, for A/B reproduction. */
  | 'heuristic'
  /** Either signal; used when a host version cannot stamp the marker. */
  | 'either'

export interface CompilerToolConfig {
  name: string
  description: string
  parameters: string[]
  coerce?: 'string' | 'raw'
}

export interface Config {
  provider: string
  model: string
  reasoningEffort?: string
  temperature: number
  maxTokens: number
  maxReplans: number
  maxParallel: number
  maxToolOutputChars: number
  tools: CompilerToolConfig[]
  plannerPrompt?: string
  joinerPrompt?: string
  detect: DetectMode
  emptyAnswer: 'diagnostic' | 'error'
  metricsPath?: string
  callIdPrefix: string
  trace: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().required().description('Planner/joiner provider route.'),
  model: z.string().required().description('Planner/joiner model id.'),
  reasoningEffort: z.string().description('Optional reasoning effort for the planner and joiner calls. Omit to let the adapter default apply.'),
  temperature: z.number().min(0).max(2).default(0),
  maxTokens: z.natural().min(1).max(1_000_000).default(2048)
    .description('Planner/joiner single-call cap. The reference engine defaults to 2048; its ParallelQA overlay raised it to 4096.'),
  maxReplans: z.natural().min(0).max(32).default(1)
    .description('Replan rounds after the first plan; the engine runs maxReplans + 1 plan rounds.'),
  maxParallel: z.natural().min(0).max(64).default(0)
    .description('Cap concurrent dispatches inside one ready wave. 0 sends the whole wave at once, as the reference engine does.'),
  maxToolOutputChars: z.natural().min(0).max(1_000_000).default(0)
    .description('Observation cap fed to the joiner and the next plan. 0 keeps the full observation, as the reference engine does.'),
  tools: z.array(z.object({
    name: z.string().required(),
    description: z.string().required(),
    parameters: z.array(z.string()).default([]),
    coerce: z.union(['string', 'raw']).default('string'),
  })).default(defaultTools() as CompilerToolConfig[])
    .description('Planner-visible tool vocabulary. Defaults to the ParallelQA search/math pair.'),
  plannerPrompt: z.string().description('Planner system prompt override; replaces the generated prompt.'),
  joinerPrompt: z.string().description('Joiner prompt override; replaces the LLMCompiler OUTPUT_PROMPT.'),
  detect: z.union(['marker', 'heuristic', 'either']).default('heuristic')
    .description('Loop-request discriminator. heuristic reproduces the reference demo; marker uses the host marker; either accepts both.'),
  emptyAnswer: z.union(['diagnostic', 'error']).default('diagnostic')
    .description('What to emit when a compiled turn yields no answer. diagnostic says so in the assistant text; error ends the call with DAG_COMPILER_EMPTY_ANSWER.'),
  metricsPath: z.string().description('Optional JSONL sink, one record per compiled turn.'),
  callIdPrefix: z.string().default('dag'),
  trace: z.boolean().default(true),
})

/**
 * Narrow the configured tool list to planner specs.
 * @param tools - the configured entries.
 * @returns the specs the prompt builder and executor consume.
 */
export function toolSpecsOf(tools: readonly CompilerToolConfig[]): ToolSpec[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: [...tool.parameters],
    coerce: tool.coerce ?? 'string',
  }))
}
