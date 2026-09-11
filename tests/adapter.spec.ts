import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createAntigravityAdapter } from '../src/adapter.ts'
import { CcaHttpError } from '../src/cca-client.ts'
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

function asScripts(events: CcaEvent[] | CcaEvent[][] | undefined): CcaEvent[][] {
  if (events === undefined) return [[{ type: 'finish', reason: 'STOP' }]]
  if (events.length > 0 && !Array.isArray(events[0])) return [events as CcaEvent[]]
  return events as CcaEvent[][]
}

function fakeSession(script: {
  chat?: CcaEvent[] | CcaEvent[][]
  search?: CcaEvent[] | CcaEvent[][]
}) {
  const chatBodies: ChatGenerateInput[] = []
  const searchQueries: string[] = []
  const chatScripts = asScripts(script.chat)
  const searchScripts = asScripts(script.search ?? [{ type: 'text', text: 'grounded news' }, { type: 'finish', reason: 'STOP' }])
  let chatIndex = 0
  let searchIndex = 0
  const cca = {
    async *chat(_oauth: unknown, input: ChatGenerateInput): AsyncIterable<CcaEvent> {
      chatBodies.push(input)
      const events = chatScripts[Math.min(chatIndex, chatScripts.length - 1)] ?? [{ type: 'finish' as const, reason: 'STOP' }]
      chatIndex += 1
      for (const event of events) yield event
    },
    async *search(_oauth: unknown, input: SearchGenerateInput): AsyncIterable<CcaEvent> {
      searchQueries.push(input.query)
      const events = searchScripts[Math.min(searchIndex, searchScripts.length - 1)] ?? [{ type: 'text' as const, text: 'grounded news' }, { type: 'finish' as const, reason: 'STOP' }]
      searchIndex += 1
      for (const event of events) yield event
    },
  }
  const session = {
    thoughtSignatures: new Map<string, string>(),
    acquire: async () => ({
      oauth,
      accountId: 'acc_test',
      email: 'test@example.test',
      cca,
    }),
    cca,
  } as unknown as AntigravitySession
  return { session, chatBodies, searchQueries }
}

function visibleText(chunks: StreamChunk[]): string {
  return chunks
    .filter(chunk => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
}

function functionResponses(input: ChatGenerateInput | undefined): Array<{ name: string, result: unknown }> {
  if (input === undefined) return []
  const found: Array<{ name: string, result: unknown }> = []
  for (const content of input.contents) {
    for (const part of content.parts) {
      if (!('functionResponse' in part)) continue
      found.push({
        name: part.functionResponse.name,
        result: part.functionResponse.response.result,
      })
    }
  }
  return found
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

  it('runs googleSearch when the model forgets to call search_web, then continues the chat', async () => {
    const fake = fakeSession({
      chat: [
        [{ type: 'text', text: 'I will look that up.' }, { type: 'finish', reason: 'STOP' }],
        [{ type: 'text', text: '根据搜索，今天这些值得看。' }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options(NEWS)))
    expect(fake.searchQueries).toEqual([NEWS])
    expect(fake.chatBodies).toHaveLength(2)
    const text = visibleText(chunks)
    expect(text).toContain('I will look that up.')
    expect(text).toContain('根据搜索，今天这些值得看。')
    expect(text).not.toContain('grounded news')
    expect(JSON.stringify(fake.chatBodies[1]?.contents)).toContain('grounded news')
    expect(fake.chatBodies[1]?.system).toContain('same language the user used')
  })

  it('drops a hallucinated generate_image call and still searches news', async () => {
    const fake = fakeSession({
      chat: [
        [{
          type: 'functionCall',
          name: 'generate_image',
          args: { prompt: 'kitten' },
        }, { type: 'finish', reason: 'STOP' }],
        [{ type: 'text', text: '新闻如下。' }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options(NEWS)))
    expect(fake.searchQueries).toEqual([NEWS])
    const text = visibleText(chunks)
    expect(text).toContain('新闻如下。')
    expect(text).not.toContain('grounded news')
    expect(text).not.toContain('Image generation failed')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('feeds search_web results back as a functionResponse and continues', async () => {
    const fake = fakeSession({
      chat: [
        [{
          type: 'functionCall',
          id: 'call_search',
          name: 'search_web',
          args: { query: 'vendor official docs' },
          thoughtSignature: 'sig-search',
        }, { type: 'finish', reason: 'STOP' }],
        [{ type: 'text', text: '按官方文档这样填。' }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options('你查一下官方资料')))
    expect(fake.searchQueries).toEqual(['vendor official docs'])
    expect(fake.session.thoughtSignatures.get('call_search')).toBe('sig-search')
    expect(visibleText(chunks)).toBe('按官方文档这样填。')
    expect(visibleText(chunks)).not.toContain('grounded news')
    expect(functionResponses(fake.chatBodies[1])).toEqual([
      { name: 'search_web', result: 'grounded news' },
    ])
    const followUpCall = fake.chatBodies[1]?.contents
      .flatMap(content => content.parts)
      .find(part => 'functionCall' in part) as {
        functionCall: { name: string, id?: string }
        thoughtSignature?: string
      }
    expect(followUpCall?.functionCall.name).toBe('search_web')
    expect(followUpCall?.thoughtSignature).toBe('sig-search')
    expect(chunks.find(chunk => chunk.type === 'finish')).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
    })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })

  it('searches a research prompt even when the model only thinks then stops', async () => {
    const fake = fakeSession({
      chat: [
        [{ type: 'thought', text: 'Identifying the Target Platform' }, { type: 'finish', reason: 'STOP' }],
        [{ type: 'text', text: '按官方文档这样配。' }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options('帮我调研一下这个 API 官方怎么配')))
    expect(fake.searchQueries).toHaveLength(1)
    expect(fake.searchQueries[0]).toContain('调研')
    expect(visibleText(chunks)).toContain('按官方文档这样配。')
    expect(visibleText(chunks)).not.toContain('grounded news')
    expect(chunks.find(chunk => chunk.type === 'finish')).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
    })
  })

  it('continues a thought-only stop that is not a search prompt', async () => {
    const fake = fakeSession({
      chat: [
        [{ type: 'thought', text: 'Hmm.' }, { type: 'finish', reason: 'STOP' }],
        [{ type: 'text', text: '好的，我在。' }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options('你好')))
    expect(fake.searchQueries).toEqual([])
    expect(fake.chatBodies).toHaveLength(2)
    expect(JSON.stringify(fake.chatBodies[1]?.contents)).toContain('only internal reasoning')
    expect(visibleText(chunks)).toBe('好的，我在。')
  })

  it('does not stop after a search_web loop with no user-visible answer', async () => {
    const fake = fakeSession({
      chat: [
        [{
          type: 'thought',
          text: 'Need current docs.',
        }, {
          type: 'functionCall',
          name: 'search_web',
          args: { query: 'vendor docs query one' },
        }, { type: 'finish', reason: 'STOP' }],
        [{
          type: 'functionCall',
          name: 'search_web',
          args: { query: 'vendor docs query two' },
        }, { type: 'finish', reason: 'STOP' }],
        [{
          type: 'functionCall',
          name: 'search_web',
          args: { query: 'vendor docs query three' },
        }, { type: 'finish', reason: 'STOP' }],
        [{ type: 'text', text: '按官方文档这样配。' }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options('帮我调研一下这个 API 官方怎么配')))
    expect(fake.searchQueries).toEqual([
      'vendor docs query one',
      'vendor docs query two',
      'vendor docs query three',
    ])
    expect(fake.chatBodies.length).toBeGreaterThanOrEqual(4)
    const answerTurn = fake.chatBodies.at(-1)
    expect(answerTurn?.functions.some(tool => tool.name === 'search_web')).toBe(false)
    expect(visibleText(chunks)).toContain('按官方文档这样配。')
    expect(chunks.find(chunk => chunk.type === 'finish')).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
    })
  })

  it('lets the model call ordinary tools after search_web returns', async () => {
    const fake = fakeSession({
      chat: [
        [{
          type: 'functionCall',
          name: 'search_web',
          args: { query: 'vendor context window' },
        }, { type: 'finish', reason: 'STOP' }],
        [{
          type: 'functionCall',
          id: 'call_read',
          name: 'read_file',
          args: { path: '/tmp/settings.yaml' },
        }, { type: 'finish', reason: 'STOP' }],
      ],
    })
    const adapter = createAntigravityAdapter(fake.session, {
      nativeTools: true,
      nativeSearch: true,
    })
    const chunks = await collect(adapter.stream(options('对照文档再决定怎么写')))
    expect(fake.searchQueries).toEqual(['vendor context window'])
    expect(visibleText(chunks)).toBe('')
    const tool = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(tool).toMatchObject({ name: 'read_file', id: 'call_read' })
    expect(chunks.find(chunk => chunk.type === 'finish')).toEqual({
      type: 'finish',
      reason: { kind: 'tool-calls' },
    })
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
    ;(fake.session as unknown as { cca: { chat: unknown } }).cca.chat = async function* (_oauth: unknown, input: ChatGenerateInput) {
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

  it('names the exhausted account and marks it rate limited on a quota error', async () => {
    const limited: string[] = []
    const session = {
      thoughtSignatures: new Map<string, string>(),
      acquire: async () => ({
        oauth,
        accountId: 'acc_one',
        email: 'a@example.test',
        cca: {
          async *chat(): AsyncIterable<CcaEvent> {
            throw new CcaHttpError(429, 'RESOURCE_EXHAUSTED')
          },
        },
      }),
      noteRateLimited: (id: string) => { limited.push(id) },
    } as unknown as AntigravitySession
    const adapter = createAntigravityAdapter(session, {
      nativeTools: true,
      nativeSearch: true,
    })
    await expect(collect(adapter.stream(options('hi')))).rejects.toThrow(/a@example\.test/)
    expect(limited).toEqual(['acc_one'])
  })
})
