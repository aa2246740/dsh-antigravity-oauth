import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createAntigravityAdapter } from '../src/adapter.ts'
import type { AntigravitySession } from '../src/session.ts'
import type { CcaEvent, ChatGenerateInput, SearchGenerateInput } from '../src/types.ts'

const oauth = {
  type: 'oauth' as const,
  access: 't',
  refresh: 'r',
  expires: Date.now() + 60_000,
  projectId: 'proj',
}

const NEWS = '搜搜新闻看看最近 12 小时科技圈值得关注的新闻'

function options(text: string): GenerateOptions {
  return {
    provider: 'agy-google-antigravity',
    model: 'gemini-3.7-flash',
    messages: [{
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }],
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
  } as unknown as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function fakeSession(script: {
  chat?: CcaEvent[]
  search?: CcaEvent[]
}) {
  const chatBodies: ChatGenerateInput[] = []
  const searchQueries: string[] = []
  const session = {
    thoughtSignatures: new Map<string, string>(),
    refreshIfNeeded: async () => oauth,
    cca: {
      async *chat(_oauth: unknown, input: ChatGenerateInput): AsyncIterable<CcaEvent> {
        chatBodies.push(input)
        for (const event of script.chat ?? [{ type: 'finish', reason: 'STOP' }]) yield event
      },
      async *search(_oauth: unknown, input: SearchGenerateInput): AsyncIterable<CcaEvent> {
        searchQueries.push(input.query)
        for (const event of script.search ?? [{ type: 'text', text: 'grounded news' }, { type: 'finish', reason: 'STOP' }]) {
          yield event
        }
      },
    },
  } as unknown as AntigravitySession
  return { session, chatBodies, searchQueries }
}

describe('AntigravityAdapter search', () => {
  it('never offers generate_image, even for a kitten prompt', async () => {
    const fake = fakeSession({
      chat: [{ type: 'text', text: 'ok' }, { type: 'finish', reason: 'STOP' }],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    await collect(adapter.stream(options('给我生成一张小猫图')))
    const names = fake.chatBodies[0]?.functions.map(tool => tool.name) ?? []
    expect(names).toContain('search_web')
    expect(names).not.toContain('generate_image')
  })

  it('runs googleSearch when the model forgets to call search_web', async () => {
    const fake = fakeSession({
      chat: [{ type: 'text', text: 'I will look that up.' }, { type: 'finish', reason: 'STOP' }],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options(NEWS)))
    expect(fake.searchQueries).toEqual([NEWS])
    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toContain('grounded news')
  })

  it('drops a hallucinated generate_image call and still searches news', async () => {
    const fake = fakeSession({
      chat: [{
        type: 'functionCall',
        name: 'generate_image',
        args: { prompt: 'kitten' },
      }, { type: 'finish', reason: 'STOP' }],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options(NEWS)))
    expect(fake.searchQueries).toEqual([NEWS])
    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toContain('grounded news')
    expect(text).not.toContain('Image generation failed')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('replays thought_signature on the next CCA functionCall part', async () => {
    const fake = fakeSession({
      chat: [{
        type: 'functionCall',
        id: 'call_skill',
        name: 'skill',
        args: { name: 'unslop' },
        thoughtSignature: 'sig-abc',
      }, { type: 'finish', reason: 'STOP' }],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    await collect(adapter.stream(options('hi')))
    expect(fake.session.thoughtSignatures.get('call_skill')).toBe('sig-abc')

    const followUp: GenerateOptions = {
      ...options('continue'),
      messages: [
        {
          id: 'u1',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'hi' }],
        },
        {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'agy-google-antigravity', model: 'gemini-3.7-flash' },
          content: [{
            type: 'tool-call',
            id: 'call_skill',
            name: 'skill',
            arguments: '{"name":"unslop"}',
          }],
        },
        {
          id: 't1',
          role: 'user',
          source: { kind: 'tool', callId: 'call_skill' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_skill',
            content: [{ type: 'text', text: 'loaded' }],
          }],
        },
      ],
    } as unknown as GenerateOptions
    fake.session.cca.chat = async function* (_oauth: unknown, input: ChatGenerateInput) {
      fake.chatBodies.push(input)
      yield { type: 'text' as const, text: 'ok' }
      yield { type: 'finish' as const, reason: 'STOP' }
    }
    await collect(adapter.stream(followUp))
    const contents = fake.chatBodies.at(-1)?.contents ?? []
    const model = contents.find(entry => entry.role === 'model')
    const call = model?.parts.find(part => 'functionCall' in part) as {
      functionCall: { name: string }
      thoughtSignature?: string
    }
    expect(call?.functionCall.name).toBe('skill')
    expect(call?.thoughtSignature).toBe('sig-abc')
    const tool = contents.find(entry => entry.role === 'user' && entry.parts.some(part => 'functionResponse' in part))
    const response = tool?.parts.find(part => 'functionResponse' in part) as {
      functionResponse: { name: string }
    }
    expect(response?.functionResponse.name).toBe('skill')
  })
})
