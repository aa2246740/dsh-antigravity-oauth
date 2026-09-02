import { CCA_ENDPOINTS, IMAGE_MODEL, IMAGE_MODEL_FALLBACKS } from './ids.ts'
import { advanceEnvelope, buildChatBody, buildImageBody, streamGenerateContentUrl } from './envelope.ts'
import type { CcaRequestBody } from './envelope.ts'
import { parseCcaChunk, readSseJson } from './sse.ts'
import type {
  AntigravityOAuth,
  CcaEvent,
  CcaGenerateInput,
  CcaSession,
  ChatGenerateInput,
  ImageGenerateInput,
  ImageWireModelId,
} from './types.ts'
import { antigravityUserAgent } from './user-agent.ts'

export class CcaHttpError extends Error {
  readonly status: number

  constructor(status: number, body: string) {
    super(`CCA ${status}: ${body.slice(0, 800)}`)
    this.name = 'CcaHttpError'
    this.status = status
  }
}

function isImageFallbackStatus(error: Error): boolean {
  return error instanceof CcaHttpError && (error.status === 404 || error.status === 403)
}

export type CcaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type CcaClientOptions = {
  session: CcaSession
  fetch?: CcaFetch
  userAgent?: () => string
  now?: () => number
}

function classifyStatus(status: number, kind: CcaGenerateInput['kind']): 'auth' | 'retry' | 'fail' {
  if (status === 401) return 'auth'
  if (status === 403) return kind === 'image' ? 'retry' : 'auth'
  if (status === 404 && kind === 'image') return 'retry'
  if (status === 429 || status >= 500) return 'retry'
  return 'fail'
}

function imageModels(preferred?: ImageWireModelId): ImageWireModelId[] {
  const first = preferred ?? IMAGE_MODEL
  return [first, ...IMAGE_MODEL_FALLBACKS.filter(id => id !== first)]
}

export class CcaClient {
  readonly session: CcaSession
  private readonly fetchImpl: CcaFetch
  private readonly userAgent: () => string
  private readonly now: () => number
  private lastExecutionId: string | undefined

  constructor(options: CcaClientOptions) {
    this.session = options.session
    this.fetchImpl = options.fetch ?? fetch
    this.userAgent = options.userAgent ?? antigravityUserAgent
    this.now = options.now ?? Date.now
  }

  async *chat(oauth: AntigravityOAuth, input: ChatGenerateInput, signal?: AbortSignal): AsyncIterable<CcaEvent> {
    yield* this.generate(oauth, input, signal)
  }

  async *image(oauth: AntigravityOAuth, input: ImageGenerateInput, signal?: AbortSignal): AsyncIterable<CcaEvent> {
    let lastError: Error | undefined
    for (const model of imageModels(input.model)) {
      try {
        yield* this.generate(oauth, { ...input, model }, signal)
        return
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (signal?.aborted) throw lastError
        if (isImageFallbackStatus(lastError)) continue
        throw lastError
      }
    }
    throw lastError ?? new Error('CCA image request failed')
  }

  private endpoints(): string[] {
    const last = this.session.lastGoodEndpoint
    const rest = CCA_ENDPOINTS.filter(endpoint => endpoint !== last)
    return last.length > 0 ? [last, ...rest] : [...CCA_ENDPOINTS]
  }

  private headers(access: string): Record<string, string> {
    return {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': this.userAgent(),
    }
  }

  private async *generate(
    oauth: AntigravityOAuth,
    input: CcaGenerateInput,
    signal?: AbortSignal,
  ): AsyncIterable<CcaEvent> {
    const body = input.kind === 'image'
      ? buildImageBody(oauth.projectId, input, this.now())
      : buildChatBody(oauth.projectId, input, advanceEnvelope(this.session, input.model, this.now(), this.lastExecutionId))
    const endpoints = this.endpoints()
    let lastError: Error | undefined
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index]!
      const url = streamGenerateContentUrl(endpoint)
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: this.headers(oauth.access),
          body: JSON.stringify(body),
          signal,
        })
        if (!response.ok) {
          const text = await response.text()
          const error = new CcaHttpError(response.status, text)
          const kind = classifyStatus(response.status, input.kind)
          if (kind === 'retry' && index < endpoints.length - 1) {
            lastError = error
            continue
          }
          throw error
        }
        if (response.body === null) throw new Error('CCA stream had no body')
        this.session.lastGoodEndpoint = endpoint
        let sawFinish = false
        for await (const raw of readSseJson(response.body, signal)) {
          const events = parseCcaChunk(raw)
          for (const event of events) {
            if (event.type === 'finish' && event.responseId !== undefined) {
              if (input.kind === 'chat') this.lastExecutionId = event.responseId
              sawFinish = true
            }
            if (event.type === 'error') throw new Error(event.message)
            yield event
          }
        }
        if (!sawFinish) yield { type: 'finish', reason: 'STOP' }
        return
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (signal?.aborted) throw lastError
        if (index === endpoints.length - 1) throw lastError
      }
    }
    throw lastError ?? new Error('CCA request failed')
  }
}

export function inspectChatRequest(projectId: string, input: ChatGenerateInput, session: CcaSession, now = Date.now()): {
  url: string
  body: CcaRequestBody
} {
  const envelope = advanceEnvelope(session, input.model, now)
  return {
    url: streamGenerateContentUrl(session.lastGoodEndpoint),
    body: buildChatBody(projectId, input, envelope),
  }
}

export function inspectImageRequest(projectId: string, input: ImageGenerateInput, session: CcaSession, now = Date.now()): {
  url: string
  body: CcaRequestBody
} {
  return {
    url: streamGenerateContentUrl(session.lastGoodEndpoint),
    body: buildImageBody(projectId, input, now),
  }
}
