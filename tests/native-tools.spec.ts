import { describe, expect, it } from 'vitest'
import {
  ccaFunctionDeclarations,
  filterDshWebTools,
  GENERATE_IMAGE_TOOL,
  maskDshWebAssembly,
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

  it('adds generate_image and keeps googleSearch on the CCA function list separately', () => {
    const functions = ccaFunctionDeclarations(
      [{ name: 'web_search', description: 'search', parameters: {} }, { name: 'read_file', description: 'read', parameters: {} }],
      true,
    )
    expect(functions.some(tool => tool.name === 'web_search')).toBe(false)
    expect(functions.some(tool => tool.name === GENERATE_IMAGE_TOOL)).toBe(true)
    expect(functions.some(tool => tool.name === 'read_file')).toBe(true)
  })

  it('masks DSH web tools in system-prompt assembly', () => {
    const masked = maskDshWebAssembly({
      tools: [{ name: 'web_search' }, { name: 'read_file' }],
      sections: [{ name: 'tool:web_search', text: 'search' }, { name: 'other', text: 'ok' }],
    })
    expect(masked.tools.map(tool => tool.name)).toEqual(['read_file'])
    expect(masked.sections.some(section => section.name === 'antigravity:native-tools')).toBe(true)
    expect(masked.sections.some(section => section.name === 'tool:web_search')).toBe(false)
  })
})
