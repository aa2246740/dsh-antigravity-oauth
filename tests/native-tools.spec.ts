import { describe, expect, it } from 'vitest'
import {
  ccaFunctionDeclarations,
  filterDshWebTools,
  GENERATE_IMAGE_TOOL,
  latestUserText,
  maskDshWebAssembly,
  wantsNativeImage,
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
      false,
    )
    const tool = functions.find(entry => entry.name === 'cua_list_windows')
    const dump = JSON.stringify(tool?.parameters)
    expect(dump).not.toMatch(/"type":\[/)
    expect((tool?.parameters.properties as { title: { type: string } }).title.type).toBe('string')
  })

  it('adds generate_image and search_web, hiding DSH web_search', () => {
    const functions = ccaFunctionDeclarations(
      [{ name: 'web_search', description: 'search', parameters: {} }, { name: 'read_file', description: 'read', parameters: {} }],
      true,
    )
    expect(functions.some(tool => tool.name === 'web_search')).toBe(false)
    expect(functions.some(tool => tool.name === GENERATE_IMAGE_TOOL)).toBe(true)
    expect(functions.some(tool => tool.name === 'search_web')).toBe(true)
    expect(functions.some(tool => tool.name === 'read_file')).toBe(true)
  })

  it('omits generate_image when image is disabled', () => {
    const functions = ccaFunctionDeclarations(
      [{ name: 'read_file', description: 'read', parameters: {} }],
      false,
      true,
    )
    expect(functions.some(tool => tool.name === GENERATE_IMAGE_TOOL)).toBe(false)
    expect(functions.some(tool => tool.name === 'search_web')).toBe(true)
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

  it('detects image vs search intent on the session that failed in DSH.app', () => {
    expect(wantsNativeImage('给我生成一张小猫图')).toBe(true)
    expect(wantsNativeImage('搜搜新闻看看最近 12 小时科技圈值得关注的新闻')).toBe(false)
    expect(wantsNativeSearch('搜搜新闻看看最近 12 小时科技圈值得关注的新闻')).toBe(true)
    expect(wantsNativeSearch('给我生成一张小猫图')).toBe(false)
    expect(wantsNativeSearch('你好')).toBe(false)
    expect(wantsNativeImage('draw me a cat')).toBe(true)
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

  it('mentions generate_image only when native image is enabled', () => {
    const masked = maskDshWebAssembly({
      tools: [{ name: 'read_file' }],
      sections: [{ name: 'other', text: 'ok' }],
    }, true)
    const guidance = masked.sections.find(section => section.name === 'antigravity:native-tools')?.text ?? ''
    expect(guidance).toContain('Call generate_image only')
    expect(guidance).not.toContain('This route has no image generation')
  })
})
