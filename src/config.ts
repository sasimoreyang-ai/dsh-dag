import z from '@deepseek-ai/schemastery'

export interface Config {
  maxConcurrency: number
  maxNodes: number
  timeoutMs: number
  maxInputChars: number
  maxNodeOutputChars: number
  trace: boolean
}

export const Config: z<Config> = z.object({
  maxConcurrency: z.natural().min(1).max(16).default(4),
  maxNodes: z.natural().min(1).max(128).default(32),
  timeoutMs: z.natural().min(1).max(3_600_000).default(120_000),
  maxInputChars: z.natural().min(1).max(4_000_000).default(200_000),
  maxNodeOutputChars: z.natural().min(128).max(100_000).default(8_000),
  trace: z.boolean().default(true),
})
