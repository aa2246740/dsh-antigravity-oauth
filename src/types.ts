export type CcaKind = 'chat' | 'image'

export type AntigravityOAuth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  projectId: string
  email?: string
}

export type CcaSession = {
  agentId: string
  trajectoryId: string
  stepIndex: number
  sessionId: string
  lastGoodEndpoint: string
}

export type PublicModelId = 'gemini-3.7-flash' | 'gemini-3.5-flash'

export type ReasoningEffort = 'low' | 'medium' | 'high'

export type ChatWireModelId =
  | 'gemini-3.7-flash-low'
  | 'gemini-3.7-flash-medium'
  | 'gemini-3.7-flash-high'
  | 'gemini-3.5-flash-extra-low'
  | 'gemini-3.5-flash-low'
  | 'gemini-3-flash-agent'

export type ImageWireModelId =
  | 'gemini-3-pro-image'
  | 'gemini-3.1-flash-image'
  | 'gemini-3-pro-image-preview'

export type WireModelId = ChatWireModelId | ImageWireModelId

export type GeminiPart =
  | { text: string, thought?: boolean, thoughtSignature?: string }
  | { functionCall: { name: string, args: Record<string, unknown>, id?: string } }
  | { functionResponse: { name: string, response: Record<string, unknown>, id?: string } }
  | { inlineData: { mimeType: string, data: string } }

export type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type FunctionToolDeclaration = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ChatGenerateInput = {
  kind: 'chat'
  model: ChatWireModelId
  contents: GeminiContent[]
  system?: string
  functions: readonly FunctionToolDeclaration[]
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'
}

export type ImageGenerateInput = {
  kind: 'image'
  prompt: string
  model?: ImageWireModelId
  aspectRatio?: string
  imageSize?: string
  inputImages?: readonly { mimeType: string, data: string }[]
}

export type CcaGenerateInput = ChatGenerateInput | ImageGenerateInput

export type CcaUsage = {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
}

export type CcaEvent =
  | { type: 'text', text: string }
  | { type: 'thought', text: string }
  | { type: 'functionCall', id?: string, name: string, args: Record<string, unknown> }
  | { type: 'inlineImage', mimeType: string, data: string }
  | { type: 'usage', usage: CcaUsage }
  | { type: 'finish', reason: string, responseId?: string }
  | { type: 'error', code?: number, message: string }

export type AntigravityAccountState =
  | { status: 'signed-out' }
  | { status: 'signing-in', url?: string }
  | { status: 'signed-in', email?: string, expiresAt?: string, projectId: string }
  | { status: 'error', message: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
