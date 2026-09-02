import type { ChatWireModelId, PublicModelId, ReasoningEffort } from './types.ts'

export const PUBLIC_MODELS = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
] as const satisfies readonly {
  id: PublicModelId
  name: string
  contextWindow: number
  maxTokens: number
}[]

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const satisfies readonly ReasoningEffort[]

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

const FLASH_38: Record<ReasoningEffort, ChatWireModelId> = {
  low: 'gemini-3.8-flash-low',
  medium: 'gemini-3.8-flash-medium',
  high: 'gemini-3.8-flash-high',
}

const FLASH_37: Record<ReasoningEffort, ChatWireModelId> = {
  low: 'gemini-3.7-flash-low',
  medium: 'gemini-3.7-flash-medium',
  high: 'gemini-3.7-flash-high',
}

const FLASH_35: Record<ReasoningEffort, ChatWireModelId> = {
  low: 'gemini-3.5-flash-extra-low',
  medium: 'gemini-3.5-flash-low',
  high: 'gemini-3-flash-agent',
}

const WIRE: Record<PublicModelId, Record<ReasoningEffort, ChatWireModelId>> = {
  'gemini-3.8-flash': FLASH_38,
  'gemini-3.7-flash': FLASH_37,
  'gemini-3.5-flash': FLASH_35,
}

const THINKING_LEVEL: Record<ReasoningEffort, 'LOW' | 'MEDIUM' | 'HIGH'> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
}

export function isPublicModelId(id: string): id is PublicModelId {
  return id === 'gemini-3.8-flash' || id === 'gemini-3.7-flash' || id === 'gemini-3.5-flash'
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
}

export function routeChatModel(model: PublicModelId, effort: ReasoningEffort = DEFAULT_REASONING_EFFORT): ChatWireModelId {
  return WIRE[model][effort]
}

export function thinkingLevelFor(model: PublicModelId, effort: ReasoningEffort): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  return model === 'gemini-3.5-flash' ? undefined : THINKING_LEVEL[effort]
}

export function publicModel(id: string): (typeof PUBLIC_MODELS)[number] | undefined {
  return PUBLIC_MODELS.find(model => model.id === id)
}
