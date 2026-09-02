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
})
