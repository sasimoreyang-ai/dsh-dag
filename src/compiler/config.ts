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
  metricsPath?: string
  callIdPrefix: string
  trace: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().required().description('Planner/joiner provider route.'),
  model: z.string().required().description('Planner/joiner model id.'),
  reasoningEffort: z.string().description('Optional reasoning effort for the planner and joiner calls. Omit to let the adapter default apply.'),
  temperature: z.number().min(0).max(2).default(0),
  maxTokens: z.natural().min(1).max(1_000_000).default(4096),
  maxReplans: z.natural().min(0).max(32).default(1)
    .description('Replan rounds after the first plan; the engine runs maxReplans + 1 plan rounds.'),
  maxParallel: z.natural().min(1).max(64).default(8)
    .description('Concurrent tool dispatches inside one ready wave.'),
  maxToolOutputChars: z.natural().min(128).max(1_000_000).default(8000)
    .description('Observation length fed to the joiner and the next plan; longer output is truncated.'),
  tools: z.array(z.object({
    name: z.string().required(),
    description: z.string().required(),
    parameters: z.array(z.string()).default([]),
    coerce: z.union(['string', 'raw']).default('string'),
  })).default(defaultTools() as CompilerToolConfig[])
    .description('Planner-visible tool vocabulary. Defaults to the ParallelQA search/math pair.'),
  plannerPrompt: z.string().description('Planner system prompt override; replaces the generated prompt.'),
  joinerPrompt: z.string().description('Joiner prompt override; replaces the LLMCompiler OUTPUT_PROMPT.'),
  detect: z.union(['marker', 'heuristic', 'either']).default('either'),
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
