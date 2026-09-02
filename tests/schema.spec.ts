import { describe, expect, it } from 'vitest'
import { sanitizeGeminiParameters, sanitizeGeminiSchema } from '../src/schema.ts'

describe('Gemini function schema', () => {
  it('collapses JSON Schema type lists so protobuf type is a string', () => {
    const cleaned = sanitizeGeminiParameters({
      type: 'object',
      properties: {
        window_id: { type: ['string', 'null'], description: 'id' },
        bounds: {
          type: 'object',
          properties: {
            x: { type: ['number', 'null'] },
            y: { type: ['integer', 'null'] },
          },
        },
      },
    })
    const dump = JSON.stringify(cleaned)
    expect(dump).not.toMatch(/"type":\[/)
    const properties = cleaned.properties as Record<string, { type?: string, nullable?: boolean }>
    expect(properties.window_id.type).toBe('string')
    expect(properties.window_id.nullable).toBe(true)
  })

  it('drops anyOf wrappers that produced the CCA 400 type-list payload', () => {
    const cleaned = sanitizeGeminiSchema({
      anyOf: [
        { type: 'null' },
        { type: 'string', description: 'path' },
      ],
    })
    expect(cleaned?.type).toBe('string')
    expect(Array.isArray(cleaned?.type)).toBe(false)
  })
})
