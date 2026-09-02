import { describe, expect, it } from 'vitest'
import { CcaClient } from '../src/cca-client.ts'
import { createCcaSession } from '../src/envelope.ts'
import type { AntigravityOAuth, CcaEvent } from '../src/types.ts'

const oauth: AntigravityOAuth = {
  type: 'oauth',
  access: 'token',
  refresh: 'refresh',
  expires: Date.now() + 60_000,
  projectId: 'proj',
}

function sseResponse(chunks: unknown[], url: string): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('CcaClient', () => {
  it('POSTs streamGenerateContent with googleSearch and records the URL', async () => {
    const seen: Array<{ url: string, body: Record<string, unknown> }> = []
    const client = new CcaClient({
      session: createCcaSession('https://daily-cloudcode-pa.googleapis.com'),
      fetch: async (input, init) => {
        const url = String(input)
        seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return sseResponse([{
          response: {
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
          },
        }], url)
      },
    })
    const events: CcaEvent[] = []
    for await (const event of client.chat(oauth, {
      kind: 'chat',
      model: 'gemini-3.7-flash-medium',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      functions: [],
    })) {
      events.push(event)
    }
    expect(seen[0]?.url).toContain('/v1internal:streamGenerateContent?alt=sse')
    expect(seen[0]?.url).not.toContain('code_challenge')
    const tools = (seen[0]?.body.request as { tools: Array<Record<string, unknown>> }).tools
    expect(tools.some(tool => tool.googleSearch !== undefined)).toBe(true)
    const instruction = (seen[0]?.body.request as { systemInstruction?: { parts: { text: string }[] } }).systemInstruction
    expect(JSON.stringify(instruction ?? {})).not.toContain('You are Antigravity')
    expect(events.some(event => event.type === 'text' && event.text === 'ok')).toBe(true)
  })

  it('image method uses imageConfig on streamGenerateContent', async () => {
    let body: Record<string, unknown> | undefined
    let url = ''
    const client = new CcaClient({
      session: createCcaSession('https://daily-cloudcode-pa.googleapis.com'),
      fetch: async (input, init) => {
        url = String(input)
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse([{
          response: {
            candidates: [{
              content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aaaa' } }] },
              finishReason: 'STOP',
            }],
          },
        }], url)
      },
    })
    const events: CcaEvent[] = []
    for await (const event of client.image(oauth, { kind: 'image', prompt: 'cube', aspectRatio: '1:1' })) {
      events.push(event)
    }
    expect(url).toContain('streamGenerateContent')
    expect(body?.model).toBe('gemini-3-pro-image')
    const request = body?.request as {
      sessionId?: string
      labels?: Record<string, string>
      generationConfig: { imageConfig: Record<string, string>, maxOutputTokens?: number }
    }
    expect(request.sessionId).toBeUndefined()
    expect(request.labels).toBeUndefined()
    expect(request.generationConfig.imageConfig.aspectRatio).toBe('1:1')
    expect(request.generationConfig.maxOutputTokens).toBeUndefined()
    expect(events.some(event => event.type === 'inlineImage')).toBe(true)
  })

  it('image after chat does not send the chat last_execution_id', async () => {
    const seen: Array<Record<string, unknown>> = []
    const client = new CcaClient({
      session: createCcaSession('https://daily-cloudcode-pa.googleapis.com'),
      fetch: async (input, init) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        const isImage = seen.length > 1
        return sseResponse([{
          response: {
            responseId: isImage ? 'exec-image' : 'exec-chat',
            candidates: [{
              content: {
                parts: isImage
                  ? [{ inlineData: { mimeType: 'image/png', data: 'aaaa' } }]
                  : [{ text: 'ok' }],
              },
              finishReason: 'STOP',
            }],
          },
        }], String(input))
      },
    })
    for await (const _event of client.chat(oauth, {
      kind: 'chat',
      model: 'gemini-3.7-flash-high',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      functions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    })) {
      // drain
    }
    for await (const _event of client.image(oauth, { kind: 'image', prompt: 'a kitten' })) {
      // drain
    }
    const chatRequest = seen[0]?.request as { labels: Record<string, string>, sessionId: string }
    expect(chatRequest.sessionId.length).toBeGreaterThan(0)
    const imageBody = seen[1]
    const imageRequest = imageBody?.request as { sessionId?: string, labels?: Record<string, string> }
    expect(imageRequest.sessionId).toBeUndefined()
    expect(imageRequest.labels).toBeUndefined()
    expect(JSON.stringify(imageBody)).not.toContain('exec-chat')

    seen.length = 0
    for await (const _event of client.chat(oauth, {
      kind: 'chat',
      model: 'gemini-3.7-flash-high',
      contents: [{ role: 'user', parts: [{ text: 'again' }] }],
      functions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    })) {
      // drain
    }
    const followUp = seen[0]?.request as { labels: Record<string, string> }
    expect(followUp.labels.last_execution_id).toBe('exec-chat')
  })

  it('falls back from gemini-3-pro-image 404 to gemini-3.1-flash-image', async () => {
    const models: string[] = []
    const client = new CcaClient({
      session: createCcaSession('https://daily-cloudcode-pa.googleapis.com'),
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string }
        models.push(body.model)
        if (body.model === 'gemini-3-pro-image') {
          return new Response(JSON.stringify({
            error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' },
          }), { status: 404, headers: { 'content-type': 'application/json' } })
        }
        return sseResponse([{
          response: {
            candidates: [{
              content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'bbbb' } }] },
              finishReason: 'STOP',
            }],
          },
        }], String(input))
      },
    })
    const events: CcaEvent[] = []
    for await (const event of client.image(oauth, { kind: 'image', prompt: 'a kitten' })) {
      events.push(event)
    }
    expect(models[0]).toBe('gemini-3-pro-image')
    expect(models).toContain('gemini-3.1-flash-image')
    expect(events.some(event => event.type === 'inlineImage' && event.data === 'bbbb')).toBe(true)
  })
})
