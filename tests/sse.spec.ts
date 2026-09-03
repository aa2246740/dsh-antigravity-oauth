import { describe, expect, it } from 'vitest'
import { parseCcaChunk } from '../src/sse.ts'

describe('parseCcaChunk thought signatures', () => {
  it('copies thoughtSignature onto functionCall events', () => {
    const events = parseCcaChunk({
      response: {
        candidates: [{
          content: {
            parts: [{
              thoughtSignature: 'sig-from-part',
              functionCall: { name: 'skill', args: { name: 'unslop' }, id: 'call_1' },
            }],
          },
          finishReason: 'STOP',
        }],
      },
    })
    const call = events.find(event => event.type === 'functionCall')
    expect(call).toMatchObject({
      type: 'functionCall',
      name: 'skill',
      id: 'call_1',
      thoughtSignature: 'sig-from-part',
    })
  })

  it('still reads functionCall when Gemini puts it on a thought part', () => {
    const events = parseCcaChunk({
      response: {
        candidates: [{
          content: {
            parts: [{
              thought: true,
              text: 'I should search.',
              thoughtSignature: 'sig-thought',
              functionCall: { name: 'search_web', args: { query: 'vendor docs' }, id: 'call_s' },
            }],
          },
          finishReason: 'STOP',
        }],
      },
    })
    expect(events.filter(event => event.type === 'thought')).toHaveLength(1)
    expect(events.find(event => event.type === 'functionCall')).toMatchObject({
      type: 'functionCall',
      name: 'search_web',
      id: 'call_s',
      thoughtSignature: 'sig-thought',
    })
  })
})
