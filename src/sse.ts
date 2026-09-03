import { isRecord } from './types.ts'
import type { CcaEvent, CcaUsage } from './types.ts'

function dataPayload(block: string): string | undefined {
  const lines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) lines.push(line.slice(5).trimStart())
  }
  if (lines.length === 0) return undefined
  return lines.join('\n')
}

export async function* readSseJson(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      const { done, value } = await reader.read()
      if (value !== undefined) buffer += value
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = done ? '' : (parts.pop() ?? '')
      const blocks = done && parts.length === 0 && buffer.length > 0 ? [buffer] : parts
      if (done && parts.length > 0 && buffer.length > 0) blocks.push(buffer)
      for (const block of blocks) {
        const payload = dataPayload(block)
        if (payload === undefined || payload.length === 0 || payload === '[DONE]') continue
        yield JSON.parse(payload) as unknown
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

function usageFrom(raw: unknown): CcaUsage | undefined {
  if (!isRecord(raw)) return undefined
  const input = typeof raw.promptTokenCount === 'number' ? raw.promptTokenCount : 0
  const output = typeof raw.candidatesTokenCount === 'number' ? raw.candidatesTokenCount : 0
  const reasoning = typeof raw.thoughtsTokenCount === 'number' ? raw.thoughtsTokenCount : undefined
  const cache = typeof raw.cachedContentTokenCount === 'number' ? raw.cachedContentTokenCount : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
    ...cache === undefined || cache === 0 ? {} : { cacheReadTokens: cache },
  }
}

export function parseCcaChunk(raw: unknown): CcaEvent[] {
  if (!isRecord(raw)) return []
  if (isRecord(raw.error)) {
    const message = typeof raw.error.message === 'string' ? raw.error.message : JSON.stringify(raw.error)
    const code = typeof raw.error.code === 'number' ? raw.error.code : undefined
    return [{ type: 'error', message, ...code === undefined ? {} : { code } }]
  }
  const response = isRecord(raw.response) ? raw.response : raw
  if (!isRecord(response)) return []
  const events: CcaEvent[] = []
  const usage = usageFrom(response.usageMetadata)
  if (usage !== undefined) events.push({ type: 'usage', usage })
  const responseId = typeof response.responseId === 'string' ? response.responseId : undefined
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  let finishReason: string | undefined
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    if (typeof candidate.finishReason === 'string') finishReason = candidate.finishReason
    const content = isRecord(candidate.content) ? candidate.content : undefined
    const parts = content !== undefined && Array.isArray(content.parts) ? content.parts : []
    let lastThoughtSignature: string | undefined
    for (const part of parts) {
      if (!isRecord(part)) continue
      const partSignature = typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
        ? part.thoughtSignature
        : undefined
      if (part.thought === true && typeof part.text === 'string') {
        if (partSignature !== undefined) lastThoughtSignature = partSignature
        events.push({ type: 'thought', text: part.text })
      } else if (typeof part.text === 'string' && part.text.length > 0) {
        events.push({ type: 'text', text: part.text })
      }
      if (isRecord(part.functionCall) && typeof part.functionCall.name === 'string') {
        const args = isRecord(part.functionCall.args) ? part.functionCall.args : {}
        const callSignature = typeof part.functionCall.thoughtSignature === 'string'
          && part.functionCall.thoughtSignature.length > 0
          ? part.functionCall.thoughtSignature
          : partSignature ?? lastThoughtSignature
        events.push({
          type: 'functionCall',
          name: part.functionCall.name,
          args,
          ...typeof part.functionCall.id === 'string' ? { id: part.functionCall.id } : {},
          ...callSignature === undefined ? {} : { thoughtSignature: callSignature },
        })
      }
      if (isRecord(part.inlineData) && typeof part.inlineData.data === 'string' && typeof part.inlineData.mimeType === 'string') {
        events.push({ type: 'inlineImage', mimeType: part.inlineData.mimeType, data: part.inlineData.data })
      }
    }
  }
  if (finishReason !== undefined) {
    events.push({
      type: 'finish',
      reason: finishReason,
      ...responseId === undefined ? {} : { responseId },
    })
  }
  return events
}
