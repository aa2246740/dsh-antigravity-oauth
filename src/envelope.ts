import { randomBytes, randomUUID } from 'node:crypto'
import { DAILY_ENDPOINT, IMAGE_MODEL } from './ids.ts'
import type {
  CcaGenerateInput,
  CcaSession,
  ChatGenerateInput,
  FunctionToolDeclaration,
  GeminiContent,
} from './types.ts'

const INT63_MASK = (1n << 63n) - 1n
const RANDOM_BOUND = 9_000_000_000_000_000_000n

const WIRE_PROFILES: Record<string, { modelEnum?: string, maxOutputTokens: number }> = {
  'gemini-3.5-flash-extra-low': { modelEnum: 'MODEL_PLACEHOLDER_M187', maxOutputTokens: 65_536 },
  'gemini-3.5-flash-low': { modelEnum: 'MODEL_PLACEHOLDER_M20', maxOutputTokens: 65_536 },
  'gemini-3-flash-agent': { modelEnum: 'MODEL_PLACEHOLDER_M132', maxOutputTokens: 65_536 },
  'gemini-3.7-flash-low': { maxOutputTokens: 65_536 },
  'gemini-3.7-flash-medium': { maxOutputTokens: 65_536 },
  'gemini-3.7-flash-high': { maxOutputTokens: 65_536 },
  'gemini-3-pro-image': { maxOutputTokens: 65_536 },
}

const IMAGE_SYSTEM_INSTRUCTION =
  'You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user\'s request.'

const IMAGE_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_ONLY_HIGH' },
] as const

function formatSignedDecimal(value: bigint): string {
  return `-${value.toString()}`
}

function randomSignedDecimalSessionId(): string {
  while (true) {
    const bytes = randomBytes(8)
    let value = 0n
    for (const byte of bytes) value = (value << 8n) | BigInt(byte)
    value &= INT63_MASK
    if (value < RANDOM_BOUND) return formatSignedDecimal(value)
  }
}

export function createCcaSession(endpoint = DAILY_ENDPOINT): CcaSession {
  return {
    agentId: randomUUID(),
    trajectoryId: randomUUID(),
    stepIndex: 1,
    sessionId: randomSignedDecimalSessionId(),
    lastGoodEndpoint: endpoint,
  }
}

export type RequestEnvelope = {
  requestId: string
  labels: Record<string, string>
  sessionId: string
  step: number
}

export function advanceEnvelope(
  session: CcaSession,
  wireModelId: string,
  now = Date.now(),
  lastExecutionId?: string,
): RequestEnvelope {
  session.stepIndex += 1
  const step = session.stepIndex
  const profile = WIRE_PROFILES[wireModelId]
  const labels: Record<string, string> = {
    last_step_index: String(step - 1),
    trajectory_id: session.trajectoryId,
  }
  if (lastExecutionId !== undefined && lastExecutionId.length > 0) {
    labels.last_execution_id = lastExecutionId
  }
  if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum
  return {
    requestId: `agent/${session.agentId}/${now}/${session.trajectoryId}/${step}`,
    labels,
    sessionId: session.sessionId,
    step,
  }
}

export function streamGenerateContentUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1internal:streamGenerateContent?alt=sse`
}

function systemInstruction(text: string, role: 'user' | undefined): { role?: 'user', parts: { text: string }[] } {
  return role === undefined
    ? { parts: [{ text }] }
    : { role, parts: [{ text }] }
}

function functionTools(functions: readonly FunctionToolDeclaration[]): Record<string, unknown>[] {
  if (functions.length === 0) return [{ googleSearch: {} }]
  return [
    { googleSearch: {} },
    {
      functionDeclarations: functions.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ]
}

export type CcaRequestBody = {
  project: string
  model: string
  request: Record<string, unknown>
  requestType: 'agent'
  userAgent: 'antigravity'
  requestId: string
}

function wrap(
  projectId: string,
  model: string,
  request: Record<string, unknown>,
  envelope: RequestEnvelope,
): CcaRequestBody {
  return {
    project: projectId,
    model,
    request: {
      ...request,
      sessionId: envelope.sessionId,
      labels: envelope.labels,
    },
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: envelope.requestId,
  }
}

export function buildChatBody(
  projectId: string,
  input: ChatGenerateInput,
  envelope: RequestEnvelope,
): CcaRequestBody {
  const profile = WIRE_PROFILES[input.model]
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: profile?.maxOutputTokens ?? 65_536,
  }
  if (input.thinkingLevel !== undefined) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: input.thinkingLevel,
    }
  } else {
    generationConfig.thinkingConfig = { includeThoughts: true }
  }
  const tools = functionTools(input.functions)
  const request: Record<string, unknown> = {
    contents: input.contents,
    generationConfig,
    tools,
    toolConfig: {
      functionCallingConfig: { mode: 'VALIDATED' },
    },
  }
  if (input.system !== undefined && input.system.length > 0) {
    request.systemInstruction = systemInstruction(input.system, 'user')
  }
  return wrap(projectId, input.model, request, envelope)
}

export function buildImageBody(
  projectId: string,
  input: Extract<CcaGenerateInput, { kind: 'image' }>,
  envelope: RequestEnvelope,
): CcaRequestBody {
  const parts: GeminiContent['parts'] = []
  for (const image of input.inputImages ?? []) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } })
  }
  parts.push({ text: input.prompt })
  const imageConfig: Record<string, string> = {}
  if (input.aspectRatio !== undefined) imageConfig.aspectRatio = input.aspectRatio
  if (input.imageSize !== undefined) imageConfig.imageSize = input.imageSize
  return wrap(projectId, IMAGE_MODEL, {
    contents: [{ role: 'user', parts }],
    systemInstruction: systemInstruction(IMAGE_SYSTEM_INSTRUCTION, undefined),
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig,
      candidateCount: 1,
      maxOutputTokens: WIRE_PROFILES[IMAGE_MODEL]?.maxOutputTokens ?? 65_536,
    },
    safetySettings: IMAGE_SAFETY,
  }, envelope)
}

export function buildCcaBody(
  projectId: string,
  input: CcaGenerateInput,
  envelope: RequestEnvelope,
): CcaRequestBody {
  return input.kind === 'chat'
    ? buildChatBody(projectId, input, envelope)
    : buildImageBody(projectId, input, envelope)
}


