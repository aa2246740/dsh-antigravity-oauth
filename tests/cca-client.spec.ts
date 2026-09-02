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

  it('search method posts googleSearch without functionDeclarations', async () => {
    let body: Record<string, unknown> | undefined
    const client = new CcaClient({
      session: createCcaSession('https://daily-cloudcode-pa.googleapis.com'),
      fetch: async (input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse([{
          response: {
            candidates: [{ content: { parts: [{ text: 'grounded' }] }, finishReason: 'STOP' }],
          },
        }], String(input))
      },
    })
    const events: CcaEvent[] = []
    for await (const event of client.search(oauth, {
      kind: 'search',
      model: 'gemini-3.7-flash-high',
      query: 'kitten news',
    })) {
      events.push(event)
    }
    const request = body?.request as {
      sessionId?: string
      tools: Array<Record<string, unknown>>
    }
    expect(request.sessionId).toBeUndefined()
    expect(request.tools).toEqual([{ googleSearch: {} }])
    expect(events.some(event => event.type === 'text' && event.text === 'grounded')).toBe(true)
  })
})
