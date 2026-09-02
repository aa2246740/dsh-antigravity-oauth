import { CCA_ENDPOINTS } from './ids.ts'
import { advanceEnvelope, buildCcaBody, streamGenerateContentUrl } from './envelope.ts'
import type { CcaRequestBody } from './envelope.ts'
import { parseCcaChunk, readSseJson } from './sse.ts'
import type {
  AntigravityOAuth,
  CcaEvent,
  CcaGenerateInput,
  CcaSession,
  ChatGenerateInput,
  ImageGenerateInput,
} from './types.ts'
import { antigravityUserAgent } from './user-agent.ts'

export type CcaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type CcaClientOptions = {
  session: CcaSession
  fetch?: CcaFetch
  userAgent?: () => string
  now?: () => number
}

function classifyStatus(status: number): 'auth' | 'retry' | 'fail' {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status >= 500) return 'retry'
  return 'fail'
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
    yield* this.generate(oauth, input, signal)
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
    const model = input.kind === 'chat' ? input.model : 'gemini-3-pro-image'
    const envelope = advanceEnvelope(this.session, model, this.now(), this.lastExecutionId)
    const body = buildCcaBody(oauth.projectId, input, envelope)
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
          const error = new Error(`CCA ${response.status}: ${text.slice(0, 800)}`)
          const kind = classifyStatus(response.status)
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
              this.lastExecutionId = event.responseId
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
    body: buildCcaBody(projectId, input, envelope),
  }
}

export function inspectImageRequest(projectId: string, input: ImageGenerateInput, session: CcaSession, now = Date.now()): {
  url: string
  body: CcaRequestBody
} {
  const envelope = advanceEnvelope(session, 'gemini-3-pro-image', now)
  return {
    url: streamGenerateContentUrl(session.lastGoodEndpoint),
    body: buildCcaBody(projectId, input, envelope),
  }
}
