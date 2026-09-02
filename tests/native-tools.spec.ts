import { describe, expect, it } from 'vitest'
import {
  ccaFunctionDeclarations,
  filterDshWebTools,
  latestUserText,
  maskDshWebAssembly,
  wantsNativeSearch,
} from '../src/native-tools.ts'

describe('native tools', () => {
  it('hides DSH web_search and web_fetch', () => {
    const kept = filterDshWebTools([
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'read_file' },
    ])
    expect(kept.map(tool => tool.name)).toEqual(['read_file'])
  })

  it('sanitizes forwarded DSH tool parameters before they hit CCA', () => {
    const functions = ccaFunctionDeclarations(
      [{
        name: 'cua_list_windows',
        description: 'list',
        parameters: {
          type: 'object',
          properties: {
            title: { type: ['string', 'null'] },
          },
        },
      }],
    )
    const tool = functions.find(entry => entry.name === 'cua_list_windows')
    const dump = JSON.stringify(tool?.parameters)
    expect(dump).not.toMatch(/"type":\[/)
    expect((tool?.parameters.properties as { title: { type: string } }).title.type).toBe('string')
  })

  it('adds search_web, hiding DSH web_search and generate_image', () => {
    const functions = ccaFunctionDeclarations(
      [
        { name: 'web_search', description: 'search', parameters: {} },
        { name: 'generate_image', description: 'draw', parameters: {} },
        { name: 'read_file', description: 'read', parameters: {} },
      ],
    )
    expect(functions.some(tool => tool.name === 'web_search')).toBe(false)
    expect(functions.some(tool => tool.name === 'generate_image')).toBe(false)
    expect(functions.some(tool => tool.name === 'search_web')).toBe(true)
    expect(functions.some(tool => tool.name === 'read_file')).toBe(true)
  })

  it('reads the latest real user text and skips harness reminders', () => {
    const text = latestUserText([
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '搜搜新闻看看最近 12 小时科技圈值得关注的新闻' }],
      },
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n<available_skills>\n- how\n</available_skills>' }],
      },
    ])
    expect(text).toBe('搜搜新闻看看最近 12 小时科技圈值得关注的新闻')
  })

  it('detects search intent without treating image prompts as search', () => {
    expect(wantsNativeSearch('搜搜新闻看看最近 12 小时科技圈值得关注的新闻')).toBe(true)
    expect(wantsNativeSearch('给我生成一张小猫图')).toBe(false)
    expect(wantsNativeSearch('你好')).toBe(false)
  })

  it('masks DSH web tools in system-prompt assembly', () => {
    const masked = maskDshWebAssembly({
      tools: [{ name: 'web_search' }, { name: 'read_file' }],
      sections: [{ name: 'tool:web_search', text: 'search' }, { name: 'other', text: 'ok' }],
    })
    expect(masked.tools.map(tool => tool.name)).toEqual(['read_file'])
    expect(masked.sections.some(section => section.name === 'antigravity:native-tools')).toBe(true)
    expect(masked.sections.some(section => section.name === 'tool:web_search')).toBe(false)
    const guidance = masked.sections.find(section => section.name === 'antigravity:native-tools')?.text ?? ''
    expect(guidance).toContain('This route has no image generation')
    expect(guidance).not.toContain('Call generate_image only')
  })
})
