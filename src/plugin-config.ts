import z from '@deepseek-ai/schemastery'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { STREAM_IDLE_TIMEOUT_MS } from './ids.ts'

export interface Config {
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  nativeTools?: boolean
  nativeSearch?: boolean
}

export const Config: z<Config> = z.object({
  streamIdleTimeoutMs: z.number().min(1).default(STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  nativeTools: z.boolean().default(true),
  nativeSearch: z.boolean().default(true),
})
