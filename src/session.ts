import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CALLBACK_PATH, CALLBACK_PORT, CALLBACK_URI, OAUTH_REFRESH_COOLDOWN_MS, OAUTH_REFRESH_SOON_MS } from './ids.ts'
import { CcaClient } from './cca-client.ts'
import { createCcaSession } from './envelope.ts'
import {
  authorizationUrl,
  completeOAuthLogin,
  extractOAuthCode,
  newOAuthState,
  refreshAccessToken,
} from './oauth.ts'
import { isSafeAuthUrl, safeMessage } from './redact.ts'
import type { AntigravityCredentialStore } from './store.ts'
import type { AntigravityAccountState, AntigravityOAuth, CcaSession } from './types.ts'
import { envProxyFetch } from './proxy-fetch.ts'
import { ensureAntigravityVersion } from './user-agent.ts'

export type FetchImpl = typeof fetch

function html(ok: boolean): string {
  const title = ok ? 'Signed in' : 'Sign-in failed'
  const body = ok ? 'You can close this window and return to DeepSeek Harness.' : 'Authorization failed. Return to DeepSeek Harness and try again.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`
}

export class AntigravitySession {
  readonly store: AntigravityCredentialStore
  readonly cca: CcaClient
  readonly ccaSession: CcaSession
  readonly thoughtSignatures = new Map<string, string>()
  private readonly fetchImpl: FetchImpl
  private lastRefreshAttempt = 0
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private listening: Promise<void> | undefined
  private pendingUrl: string | undefined
  private pendingState: string | undefined
  private callbackServer: ReturnType<typeof createServer> | undefined
  private account: AntigravityAccountState = { status: 'signed-out' }

  constructor(store: AntigravityCredentialStore, fetchImpl: FetchImpl = envProxyFetch) {
    this.store = store
    this.fetchImpl = fetchImpl
    this.ccaSession = createCcaSession()
    this.cca = new CcaClient({ session: this.ccaSession, fetch: fetchImpl })
  }

  async snapshot(): Promise<AntigravityAccountState> {
    if (this.operation !== undefined) return this.account
    if (this.account.status === 'error') return this.account
    return this.readStored()
  }

  async readStored(): Promise<AntigravityAccountState> {
    const credential = await this.store.read()
    if (credential === undefined) return { status: 'signed-out' }
    return {
      status: 'signed-in',
      projectId: credential.projectId,
      ...credential.email === undefined ? {} : { email: credential.email },
      ...Number.isNaN(credential.expires) ? {} : { expiresAt: new Date(credential.expires).toISOString() },
    }
  }

  async credential(): Promise<AntigravityOAuth | undefined> {
    return this.store.read()
  }

  async requireCredential(): Promise<AntigravityOAuth> {
    const credential = await this.refreshIfNeeded()
    if (credential === undefined) {
      throw new Error('Antigravity is not connected. Open Settings and sign in.')
    }
    return credential
  }

  async refreshIfNeeded(now = Date.now()): Promise<AntigravityOAuth | undefined> {
    const current = await this.store.read()
    if (current === undefined) return undefined
    if (now < current.expires - OAUTH_REFRESH_SOON_MS) return current
    if (now - this.lastRefreshAttempt < OAUTH_REFRESH_COOLDOWN_MS) return current
    this.lastRefreshAttempt = now
    try {
      const next = await refreshAccessToken(current, this.fetchImpl, now)
      await this.store.write(next)
      return next
    } catch {
      return current
    }
  }

  async signIn(): Promise<{ url: string }> {
    if (this.operation === undefined) this.startLogin()
    try {
      await this.listening
    } catch {
      await this.operation?.catch(() => undefined)
    }
    if (this.pendingUrl !== undefined && this.account.status === 'signing-in') return { url: this.pendingUrl }
    await this.operation?.catch(() => undefined)
    if (this.pendingUrl !== undefined && this.account.status === 'signing-in') return { url: this.pendingUrl }
    if (this.account.status === 'error') throw new Error(this.account.message)
    const stored = await this.readStored()
    if (stored.status === 'signed-in') throw new Error('already signed in')
    throw new Error('login did not produce an authorization URL')
  }

  async waitUntilSettled(): Promise<void> {
    await this.operation?.catch(() => undefined)
  }

  async complete(raw: string): Promise<AntigravityAccountState> {
    const extracted = extractOAuthCode(raw)
    if (this.pendingState !== undefined && extracted.state !== undefined && extracted.state !== this.pendingState) {
      throw new Error('OAuth state mismatch')
    }
    const credential = await completeOAuthLogin(extracted.code, this.fetchImpl)
    await this.store.write(credential)
    this.account = await this.readStored()
    this.pendingUrl = undefined
    this.pendingState = undefined
    this.cancellation?.abort(new Error('Antigravity login completed'))
    this.stopCallbackServer()
    await this.waitUntilSettled()
    this.operation = undefined
    this.cancellation = undefined
    return this.account
  }

  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('Antigravity login cancelled'))
    await this.operation?.catch(() => undefined)
    await this.stopCallbackServer()
    await this.store.clear()
    this.account = { status: 'signed-out' }
    this.pendingUrl = undefined
    this.pendingState = undefined
    this.operation = undefined
    this.cancellation = undefined
    this.listening = undefined
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('Antigravity plugin disposed'))
    await this.operation?.catch(() => undefined)
    await this.stopCallbackServer()
    this.operation = undefined
    this.cancellation = undefined
    this.listening = undefined
  }

  private startLogin(): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    const state = newOAuthState()
    this.pendingState = state
    const url = authorizationUrl(state)
    if (!isSafeAuthUrl(url)) {
      this.account = { status: 'error', message: 'authorization URL is outside Google accounts' }
      return
    }
    this.pendingUrl = url
    this.account = { status: 'signing-in', url }
    void ensureAntigravityVersion(this.fetchImpl, cancellation.signal)
    let markListening: () => void = () => undefined
    let failListening: (error: Error) => void = () => undefined
    this.listening = new Promise<void>((resolve, reject) => {
      markListening = resolve
      failListening = reject
    })
    this.operation = this.runLogin(state, cancellation.signal, markListening, failListening)
    void this.operation.finally(() => {
      this.operation = undefined
    })
  }

  private async runLogin(
    state: string,
    signal: AbortSignal,
    markListening: () => void,
    failListening: (error: Error) => void,
  ): Promise<void> {
    try {
      const hit = await this.listenForCallback(state, signal, markListening, failListening)
      try {
        const credential = await completeOAuthLogin(hit.code, this.fetchImpl, Date.now(), signal)
        await this.store.write(credential)
        this.account = await this.readStored()
        hit.reply(true)
      } catch (error: unknown) {
        hit.reply(false)
        throw error
      }
    } catch (error: unknown) {
      if (this.account.status === 'signed-in' || signal.aborted) return
      this.account = { status: 'error', message: safeMessage(error) }
      console.error('[dsh-antigravity-oauth] login failed:', safeMessage(error))
    } finally {
      this.cancellation = undefined
      this.listening = undefined
      this.pendingUrl = undefined
      this.pendingState = undefined
      await this.stopCallbackServer()
    }
  }

  private listenForCallback(
    state: string,
    signal: AbortSignal,
    onListening: () => void,
    onListenError: (error: Error) => void,
  ): Promise<{ code: string, reply: (ok: boolean) => void }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: unknown): void => {
        const err = error instanceof Error ? error : new Error(String(error))
        if (!settled) {
          settled = true
          reject(err)
        }
      }
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        try {
          const requestUrl = new URL(req.url ?? '/', CALLBACK_URI)
          if (requestUrl.pathname !== CALLBACK_PATH) {
            res.writeHead(404, { 'content-type': 'text/plain' })
            res.end('not found')
            return
          }
          const oauthError = requestUrl.searchParams.get('error')
          if (oauthError !== null && oauthError.length > 0) {
            if (!res.writableEnded) {
              res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
              res.end(html(false))
            }
            const description = requestUrl.searchParams.get('error_description')
            fail(new Error(
              description !== null && description.length > 0 ? `${oauthError}: ${description}` : oauthError,
            ))
            return
          }
          const code = requestUrl.searchParams.get('code')
          const returnedState = requestUrl.searchParams.get('state')
          if (code === null || code.length === 0 || returnedState !== state) {
            if (!res.writableEnded) {
              res.writeHead(404, { 'content-type': 'text/plain' })
              res.end('not found')
            }
            return
          }
          if (settled) {
            if (!res.writableEnded) {
              res.writeHead(409, { 'content-type': 'text/plain' })
              res.end('already handled')
            }
            return
          }
          settled = true
          resolve({
            code,
            reply: (ok: boolean) => {
              if (res.writableEnded) return
              res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
              res.end(html(ok))
            },
          })
        } catch (error: unknown) {
          fail(error)
        }
      })
      this.callbackServer = server
      const onAbort = (): void => {
        void this.stopCallbackServer()
        fail(signal.reason instanceof Error ? signal.reason : new Error('login cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      server.once('error', (error: Error) => {
        onListenError(error)
        fail(error)
      })
      server.listen(CALLBACK_PORT, '127.0.0.1', onListening)
    })
  }

  private async stopCallbackServer(): Promise<void> {
    const server = this.callbackServer
    this.callbackServer = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }
}
