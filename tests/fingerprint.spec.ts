import { describe, expect, it } from 'vitest'
import {
  authorizationQueryKeys,
  authorizationUrl,
  LOAD_CODE_ASSIST_BODY,
  SCOPES,
} from '../src/oauth.ts'
import { buildCcaBody, createCcaSession, streamGenerateContentUrl, advanceEnvelope } from '../src/envelope.ts'
import { DAILY_ENDPOINT } from '../src/ids.ts'

describe('fingerprint lessons', () => {
  it('authorization URL has no PKCE code_challenge', () => {
    const url = authorizationUrl('state-1')
    expect(url).not.toContain('code_challenge')
    expect(url).not.toContain('code_challenge_method')
    expect(new URL(url).searchParams.has('code_challenge')).toBe(false)
  })

  it('scopes exclude aicode', () => {
    expect(SCOPES.join(' ')).not.toMatch(/aicode/)
    expect(authorizationUrl('s')).not.toContain('aicode')
  })

  it('chat systemInstruction never contains You are Antigravity', () => {
    const session = createCcaSession()
    const envelope = advanceEnvelope(session, 'gemini-3.7-flash-medium')
    const body = buildCcaBody('proj', {
      kind: 'chat',
      model: 'gemini-3.7-flash-medium',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      system: 'You are a coding assistant for this workspace.',
      functions: [],
    }, envelope)
    const instruction = body.request.systemInstruction as { role?: string, parts: { text: string }[] }
    const text = instruction.parts.map(part => part.text).join('\n')
    expect(text).not.toContain('You are Antigravity')
    expect(instruction.role).toBe('user')
    expect(text).toBe('You are a coding assistant for this workspace.')
  })

  it('request URL is streamGenerateContent', () => {
    const url = streamGenerateContentUrl(DAILY_ENDPOINT)
    expect(url).toContain('streamGenerateContent')
    expect(url).toMatch(/\/v1internal:streamGenerateContent\?alt=sse$/)
    expect(url).not.toMatch(/:generateContent(\?|$)/)
  })

  it('chat tools include googleSearch', () => {
    const session = createCcaSession()
    const envelope = advanceEnvelope(session, 'gemini-3.5-flash-low')
    const body = buildCcaBody('proj', {
      kind: 'chat',
      model: 'gemini-3.5-flash-low',
      contents: [{ role: 'user', parts: [{ text: 'search this' }] }],
      functions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    }, envelope)
    const tools = body.request.tools as Array<Record<string, unknown>>
    expect(tools.some(tool => tool.googleSearch !== undefined)).toBe(true)
    const decls = tools.find(tool => Array.isArray(tool.functionDeclarations))
    const first = (decls?.functionDeclarations as Array<Record<string, unknown>>)[0]
    expect(first).toHaveProperty('parametersJsonSchema')
    expect(first).not.toHaveProperty('parameters')
  })
})

describe('golden request shapes', () => {
  it('OAuth URL query keys', () => {
    expect(authorizationQueryKeys(authorizationUrl('abc'))).toEqual([
      'access_type',
      'client_id',
      'prompt',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ])
  })

  it('loadCodeAssist body is metadata ANTIGRAVITY only', () => {
    expect(LOAD_CODE_ASSIST_BODY).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
    expect(Object.keys(LOAD_CODE_ASSIST_BODY)).toEqual(['metadata'])
  })

  it('generate envelope fields', () => {
    const session = createCcaSession()
    session.agentId = 'agent-id'
    session.trajectoryId = 'traj-id'
    session.sessionId = '-12345'
    session.stepIndex = 1
    const envelope = advanceEnvelope(session, 'gemini-3.5-flash-low', 1_700_000_000_000, 'exec-1')
    const body = buildCcaBody('proj-1', {
      kind: 'chat',
      model: 'gemini-3.5-flash-low',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      functions: [],
    }, envelope)
    expect(body.requestType).toBe('agent')
    expect(body.userAgent).toBe('antigravity')
    expect(body.requestId).toBe('agent/agent-id/1700000000000/traj-id/2')
    expect(body.request.sessionId).toBe('-12345')
    const labels = body.request.labels as Record<string, string>
    expect(labels.trajectory_id).toBe('traj-id')
    expect(labels.last_step_index).toBe('1')
    expect(labels.last_execution_id).toBe('exec-1')
    expect(labels.model_enum).toBe('MODEL_PLACEHOLDER_M20')
    expect((body.request.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode).toBe('VALIDATED')
  })

  it('image request uses imageConfig', () => {
    const session = createCcaSession()
    const envelope = advanceEnvelope(session, 'gemini-3-pro-image')
    const body = buildCcaBody('proj', {
      kind: 'image',
      prompt: 'a red cube',
      aspectRatio: '1:1',
      imageSize: '1K',
    }, envelope)
    expect(body.model).toBe('gemini-3-pro-image')
    expect(body.requestType).toBe('agent')
    const config = body.request.generationConfig as { imageConfig: { aspectRatio: string, imageSize: string } }
    expect(config.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' })
    expect(streamGenerateContentUrl(DAILY_ENDPOINT)).toContain('streamGenerateContent')
  })
})
