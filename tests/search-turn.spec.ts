import { describe, expect, it } from 'vitest'
import {
  appendContinueMemo,
  appendSearchDossier,
  appendSearchMemo,
  appendSearchTurns,
  SEARCH_ANSWER_GUIDANCE,
  SEARCH_CONTINUE_GUIDANCE,
  THOUGHT_ONLY_CONTINUE,
  withoutSearchWeb,
  withSearchContinueGuidance,
} from '../src/search-turn.ts'

describe('search follow-up turns', () => {
  it('appends functionCall then functionResponse with the real tool name', () => {
    const contents = appendSearchTurns(
      [{ role: 'user', parts: [{ text: '查一下官方资料' }] }],
      [{
        id: 'call_search',
        name: 'search_web',
        args: { query: 'vendor official docs' },
        thoughtSignature: 'sig-search',
      }],
      ['grounded English dump'],
    )
    expect(contents).toHaveLength(3)
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{
        functionCall: { name: 'search_web', args: { query: 'vendor official docs' }, id: 'call_search' },
        thoughtSignature: 'sig-search',
      }],
    })
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{
        functionResponse: {
          name: 'search_web',
          id: 'call_search',
          response: { result: 'grounded English dump' },
        },
      }],
    })
  })

  it('keeps heuristic search off the functionCall path', () => {
    const contents = appendSearchMemo(
      [{ role: 'user', parts: [{ text: '搜搜新闻' }] }],
      '搜搜新闻',
      'grounded news',
    )
    expect(contents.at(-1)?.parts[0]).toEqual({
      text: expect.stringContaining('grounded news'),
    })
    expect(JSON.stringify(contents)).not.toContain('functionCall')
    expect(JSON.stringify(contents)).toContain(SEARCH_CONTINUE_GUIDANCE)
  })

  it('does not duplicate the continue guidance on the system prompt', () => {
    const once = withSearchContinueGuidance('be helpful')
    expect(once).toContain('be helpful')
    expect(once).toContain(SEARCH_CONTINUE_GUIDANCE)
    expect(withSearchContinueGuidance(once)).toBe(once)
  })

  it('nudges a thought-only stop back into the same chat', () => {
    const contents = appendContinueMemo([{ role: 'user', parts: [{ text: '调研这个 API' }] }])
    expect(contents.at(-1)?.parts[0]).toEqual({ text: THOUGHT_ONLY_CONTINUE })
  })

  it('packs search rounds into one answer-pass memo and strips search_web', () => {
    const contents = appendSearchDossier(
      [{ role: 'user', parts: [{ text: '调研这个 API' }] }],
      [{ query: 'vendor docs query one', result: 'grounded one' }],
    )
    const packed = contents.at(-1)?.parts[0]
    expect(packed).toEqual({
      text: expect.stringContaining('vendor docs query one'),
    })
    expect(JSON.stringify(packed)).toContain('grounded one')
    expect(JSON.stringify(packed)).toContain(SEARCH_ANSWER_GUIDANCE)
    expect(withoutSearchWeb([
      { name: 'read_file', description: 'read', parameters: {} },
      { name: 'search_web', description: 'search', parameters: {} },
    ]).map(tool => tool.name)).toEqual(['read_file'])
  })
})
