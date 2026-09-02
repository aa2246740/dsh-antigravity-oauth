import { randomBytes } from 'node:crypto'
import {
  AUTH_URL,
  CALLBACK_URI,
  DAILY_ENDPOINT,
  FREE_TIER_ID,
  LOAD_CODE_ASSIST_PATH,
  ONBOARD_POLL_INTERVAL_MS,
  ONBOARD_TIMEOUT_MS,
  ONBOARD_USER_PATH,
  OAUTH_EXPIRES_SKEW_MS,
  TOKEN_URL,
  USERINFO_URL,
} from './ids.ts'
import type { AntigravityOAuth } from './types.ts'
import { isRecord } from './types.ts'
import { antigravityUserAgent } from './user-agent.ts'

export { CALLBACK_URI }

export const CLIENT_ID = atob(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
)
export const CLIENT_SECRET = atob('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=')

export const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

export const LOAD_CODE_ASSIST_BODY = Object.freeze({
  metadata: { ideType: 'ANTIGRAVITY' },
})

export const OAUTH_URL_QUERY_KEYS = [
  'access_type',
  'client_id',
  'prompt',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
] as const

export function newOAuthState(): string {
  return randomBytes(16).toString('hex')
}

export function authorizationUrl(state: string, redirectUri = CALLBACK_URI): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  return `${AUTH_URL}?${params.toString()}`
}

export function authorizationQueryKeys(url: string): string[] {
  return [...new URL(url).searchParams.keys()].sort()
}

export function extractOAuthCode(raw: string): { code: string, state?: string } {
  const trimmed = raw.trim()
  if (trimmed.includes('://') || trimmed.includes('?')) {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    if (code === null || code.length === 0) throw new Error('authorization response is missing code')
    const state = url.searchParams.get('state')
    return state === null ? { code } : { code, state }
  }
  if (trimmed.length === 0) throw new Error('authorization code is empty')
  return { code: trimmed }
}

type TokenPayload = {
  access_token: string
  refresh_token?: string
  expires_in: number
}

function parseTokenPayload(raw: unknown, filename: string): TokenPayload {
  if (!isRecord(raw)) throw new Error(`${filename} token response must be an object`)
  if (typeof raw.access_token !== 'string' || raw.access_token.length === 0) {
    throw new Error(`${filename} token response is missing access_token`)
  }
  if (typeof raw.expires_in !== 'number' || !Number.isFinite(raw.expires_in)) {
    throw new Error(`${filename} token response is missing expires_in`)
  }
  return {
    access_token: raw.access_token,
    expires_in: raw.expires_in,
    ...typeof raw.refresh_token === 'string' ? { refresh_token: raw.refresh_token } : {},
  }
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}: ${text.slice(0, 800)}`)
  }
  if (text.length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

export async function exchangeAuthorizationCode(
  code: string,
  redirectUri = CALLBACK_URI,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Omit<AntigravityOAuth, 'projectId'>> {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  const payload = parseTokenPayload(await readJson(response, 'token exchange'), 'token exchange')
  if (payload.refresh_token === undefined || payload.refresh_token.length === 0) {
    throw new Error('No refresh token received. Please try again.')
  }
  return {
    type: 'oauth',
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: now + payload.expires_in * 1000 - OAUTH_EXPIRES_SKEW_MS,
  }
}

export async function refreshAccessToken(
  current: AntigravityOAuth,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AntigravityOAuth> {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: current.refresh,
      grant_type: 'refresh_token',
    }),
  })
  const payload = parseTokenPayload(await readJson(response, 'token refresh'), 'token refresh')
  return {
    type: 'oauth',
    access: payload.access_token,
    refresh: payload.refresh_token ?? current.refresh,
    expires: now + payload.expires_in * 1000 - OAUTH_EXPIRES_SKEW_MS,
    projectId: current.projectId,
    ...current.email === undefined ? {} : { email: current.email },
  }
}

export async function fetchUserEmail(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetcher(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return undefined
    const payload = await response.json() as unknown
    return isRecord(payload) && typeof payload.email === 'string' ? payload.email : undefined
  } catch {
    return undefined
  }
}

function assistHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': antigravityUserAgent(),
  }
}

function parseLoadCodeAssist(payload: unknown): {
  projectId?: string
  hasCurrentTier: boolean
  freeTierAllowed: boolean
  ineligibility?: { reasonMessage: string, validationUrl?: string }
} {
  if (!isRecord(payload)) throw new Error('loadCodeAssist response must be an object')
  const projectId = typeof payload.cloudaicompanionProject === 'string' && payload.cloudaicompanionProject.length > 0
    ? payload.cloudaicompanionProject
    : undefined
  const hasCurrentTier = payload.currentTier !== undefined && payload.currentTier !== null
  const allowed = Array.isArray(payload.allowedTiers)
    ? payload.allowedTiers.some(tier => isRecord(tier) && tier.id === FREE_TIER_ID)
    : false
  const ineligible = Array.isArray(payload.ineligibleTiers)
    ? payload.ineligibleTiers.find(tier => isRecord(tier) && tier.tierId === FREE_TIER_ID)
    : undefined
  const ineligibility = isRecord(ineligible) && typeof ineligible.reasonMessage === 'string'
    ? {
      reasonMessage: ineligible.reasonMessage,
      ...typeof ineligible.validationUrl === 'string' && ineligible.validationUrl.length > 0
        ? { validationUrl: ineligible.validationUrl }
        : {},
    }
    : undefined
  return { projectId, hasCurrentTier, freeTierAllowed: allowed, ineligibility }
}

async function postLoadCodeAssist(
  accessToken: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<ReturnType<typeof parseLoadCodeAssist>> {
  const response = await fetcher(`${DAILY_ENDPOINT}${LOAD_CODE_ASSIST_PATH}`, {
    method: 'POST',
    headers: assistHeaders(accessToken),
    body: JSON.stringify(LOAD_CODE_ASSIST_BODY),
    signal,
  })
  return parseLoadCodeAssist(await readJson(response, 'loadCodeAssist'))
}

async function onboardUser(
  accessToken: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS
  const remaining = (): number => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`)
    return left
  }
  const headers = assistHeaders(accessToken)
  let response = await fetcher(`${DAILY_ENDPOINT}${ONBOARD_USER_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tierId: FREE_TIER_ID,
      metadata: LOAD_CODE_ASSIST_BODY.metadata,
    }),
    signal: signal === undefined ? AbortSignal.timeout(remaining()) : AbortSignal.any([signal, AbortSignal.timeout(remaining())]),
  })
  let payload = await readJson(response, 'onboardUser')
  while (true) {
    if (!isRecord(payload)) throw new Error('onboardUser response must be an object')
    if (payload.done === true) {
      if (payload.error !== undefined && payload.error !== null) {
        const error = isRecord(payload.error) ? payload.error : {}
        const message = typeof error.message === 'string' ? error.message : JSON.stringify(payload.error)
        throw new Error(`OnboardUser operation failed: ${message}`)
      }
      if (payload.response === undefined || payload.response === null) {
        throw new Error('failed to unmarshal OnboardUserResponse')
      }
      return
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining())))
    const name = typeof payload.name === 'string' ? payload.name : ''
    if (name.length === 0) throw new Error('onboardUser returned an operation without a name')
    response = await fetcher(`${DAILY_ENDPOINT}/v1internal/${name}`, {
      method: 'GET',
      headers,
      signal: signal === undefined ? AbortSignal.timeout(remaining()) : AbortSignal.any([signal, AbortSignal.timeout(remaining())]),
    })
    payload = await readJson(response, 'onboardUser operation')
  }
}

export async function discoverProject(
  accessToken: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const initial = await postLoadCodeAssist(accessToken, fetcher, signal)
  if (!initial.freeTierAllowed && initial.ineligibility !== undefined) {
    const extra = initial.ineligibility.validationUrl === undefined
      ? ''
      : `\n${initial.ineligibility.validationUrl}`
    throw new Error(`${initial.ineligibility.reasonMessage}${extra}`)
  }
  if (!initial.hasCurrentTier) await onboardUser(accessToken, fetcher, signal)
  const refreshed = await postLoadCodeAssist(accessToken, fetcher, signal)
  if (refreshed.projectId !== undefined) return refreshed.projectId
  throw new Error('loadCodeAssist did not return a cloudaicompanionProject')
}

export async function completeOAuthLogin(
  code: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<AntigravityOAuth> {
  const tokens = await exchangeAuthorizationCode(code, CALLBACK_URI, fetcher, now)
  const email = await fetchUserEmail(tokens.access, fetcher)
  const projectId = await discoverProject(tokens.access, fetcher, signal)
  return {
    ...tokens,
    projectId,
    ...email === undefined ? {} : { email },
  }
}
