import { isRecord } from './types.ts'

const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

function firstGeminiType(value: unknown): { type?: string, nullable: boolean } {
  if (typeof value === 'string') {
    if (value === 'null') return { nullable: true }
    return GEMINI_TYPES.has(value) ? { type: value, nullable: false } : { nullable: false }
  }
  if (!Array.isArray(value)) return { nullable: false }
  let type: string | undefined
  let nullable = false
  for (const entry of value) {
    if (entry === 'null') {
      nullable = true
      continue
    }
    if (typeof entry === 'string' && GEMINI_TYPES.has(entry) && type === undefined) type = entry
  }
  return { type, nullable }
}

function unionBranch(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const nonNull = raw.filter(entry => {
    if (!isRecord(entry)) return true
    return entry.type !== 'null'
  })
  return nonNull[0] ?? raw[0]
}

export function sanitizeGeminiSchema(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  const source = isRecord(unionBranch(raw.anyOf ?? raw.oneOf ?? raw.allOf))
    ? { ...raw, ...unionBranch(raw.anyOf ?? raw.oneOf ?? raw.allOf) as Record<string, unknown> }
    : raw
  const { type, nullable } = firstGeminiType(source.type)
  const out: Record<string, unknown> = {}
  if (type !== undefined) out.type = type
  if (nullable || source.nullable === true) out.nullable = true
  if (typeof source.description === 'string' && source.description.length > 0) {
    out.description = source.description
  }
  if (Array.isArray(source.enum)) {
    const values = source.enum.filter(entry => (
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
    ))
    if (values.length > 0) out.enum = values
  }
  if (Array.isArray(source.required)) {
    const required = source.required.filter(entry => typeof entry === 'string')
    if (required.length > 0) out.required = required
  }

  const properties = sanitizeProperties(source.properties)
  if (properties !== undefined) {
    out.properties = properties
    if (out.type === undefined) out.type = 'object'
  }

  if (source.items !== undefined) {
    const items = sanitizeGeminiSchema(source.items)
    if (items !== undefined) out.items = items
    if (out.type === undefined) out.type = 'array'
  }

  if (out.type === undefined && out.enum !== undefined) out.type = 'string'
  return Object.keys(out).length === 0 ? { type: 'object', properties: {} } : out
}

function sanitizeProperties(raw: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(raw)) return undefined
  const properties: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(raw)) {
    const schema = sanitizeGeminiSchema(value)
    if (schema !== undefined) properties[key] = schema
  }
  return properties
}

export function sanitizeGeminiParameters(raw: Record<string, unknown>): Record<string, unknown> {
  return sanitizeGeminiSchema(raw) ?? { type: 'object', properties: {} }
}
