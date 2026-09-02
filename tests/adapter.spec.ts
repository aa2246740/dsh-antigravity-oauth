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
  imageError?: Error
}) {
  const chatBodies: ChatGenerateInput[] = []
  const searchQueries: string[] = []
  const session = {
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
      async *image(): AsyncIterable<CcaEvent> {
        if (script.imageError !== undefined) throw script.imageError
      },
    },
  } as unknown as AntigravitySession
  return { session, chatBodies, searchQueries }
}

describe('AntigravityAdapter search', () => {
  it('does not offer generate_image when native image is off, even for a kitten prompt', async () => {
    const fake = fakeSession({
      chat: [{ type: 'text', text: 'ok' }, { type: 'finish', reason: 'STOP' }],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeImage: false,
      nativeSearch: true,
    })
    await collect(adapter.stream(options('给我生成一张小猫图')))
    const names = fake.chatBodies[0]?.functions.map(tool => tool.name) ?? []
    expect(names).toContain('search_web')
    expect(names).not.toContain('generate_image')
  })

  it('does not offer generate_image on a news turn', async () => {
    const fake = fakeSession({
      chat: [{ type: 'text', text: 'ok' }, { type: 'finish', reason: 'STOP' }],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeImage: true,
      nativeSearch: true,
    })
    await collect(adapter.stream(options(NEWS)))
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
      nativeImage: true,
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

  it('still searches after generate_image 429 on a news turn', async () => {
    const fake = fakeSession({
      chat: [{
        type: 'functionCall',
        name: 'generate_image',
        args: { prompt: 'kitten' },
      }, { type: 'finish', reason: 'STOP' }],
      imageError: new Error('CCA 429: QUOTA_EXHAUSTED gemini-3.1-flash-image'),
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeImage: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options(NEWS)))
    expect(fake.searchQueries).toEqual([NEWS])
    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toContain('grounded news')
    expect(text).toContain('Image generation failed')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
