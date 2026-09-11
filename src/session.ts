import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CALLBACK_PATH,
  CALLBACK_PORT,
  CALLBACK_URI,
  OAUTH_REFRESH_COOLDOWN_MS,
  OAUTH_REFRESH_SOON_MS,
  PRECHECK_INTERVAL_MS,
  RATE_LIMIT_COOLDOWN_MAX_MS,
  RATE_LIMIT_COOLDOWN_MS,
} from './ids.ts'
import { CcaClient } from './cca-client.ts'
import { createCcaSession } from './envelope.ts'
import {
  authorizationUrl,
  completeOAuthLogin,
  discoverProject,
  extractOAuthCode,
  newOAuthState,
  refreshAccessToken,
} from './oauth.ts'
import { isSafeAuthUrl, safeMessage } from './redact.ts'
import type { AntigravityCredentialStore } from './store.ts'
import type {
  AccountSummary,
  AntigravityGrant,
  AntigravityLease,
  AntigravityOAuth,
  AntigravityStatus,
  EligibilitySummary,
} from './types.ts'
import { AntigravityNetwork } from './network.ts'
import { ensureAntigravityVersion } from './user-agent.ts'

export type FetchImpl = typeof fetch

function html(ok: boolean, authorized = false): string {
  const title = ok ? 'Signed in' : authorized ? 'Google authorized' : 'Sign-in failed'
  const body = ok ? 'You can close this window and return to DeepSeek Harness.' : authorized
    ? 'Google authorization is saved. Return to DeepSeek Harness to check Antigravity service eligibility.'
    : 'Authorization failed. Return to DeepSeek Harness and try again.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`
}

type LoginFlow =
  | { status: 'idle' }
  | { status: 'signing-in', url?: string }
  | { status: 'error', message: string }

type AccountRuntime = {
  cca: CcaClient
  limitedUntil?: number
  limitedStrikes?: number
  dead?: boolean
}

export class AntigravitySession {
  readonly store: AntigravityCredentialStore
  readonly thoughtSignatures = new Map<string, string>()
  readonly network: AntigravityNetwork
  private readonly fetchImpl: FetchImpl
  private readonly runtimes = new Map<string, AccountRuntime>()
  private readonly precheckAt = new Map<string, number>()
  private readonly precheckInFlight = new Map<string, Promise<void>>()
  private readonly refreshAttempts = new Map<string, number>()
  private login: LoginFlow = { status: 'idle' }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private listening: Promise<void> | undefined
  private pendingUrl: string | undefined
  private pendingState: string | undefined
  private callbackServer: ReturnType<typeof createServer> | undefined
  private serviceError: string | undefined
  private completing = false
  private eligibility: EligibilitySummary | undefined

  constructor(store: AntigravityCredentialStore, fetchImpl?: FetchImpl) {
    this.store = store
    this.network = new AntigravityNetwork(store.filename + '.network.json')
    this.fetchImpl = fetchImpl ?? this.network.fetch
  }

  private runtimeFor(accountId: string): AccountRuntime {
    let runtime = this.runtimes.get(accountId)
    if (runtime === undefined) {
      runtime = { cca: new CcaClient({ session: createCcaSession(), fetch: this.fetchImpl }) }
      this.runtimes.set(accountId, runtime)
    }
    return runtime
  }

  async acquire(): Promise<AntigravityLease | undefined> {
    const grant = await this.refreshGrant()
    if (grant === undefined || grant.projectId === undefined) return undefined
    const active = await this.store.active()
    if (active === undefined) return undefined
    const runtime = this.runtimeFor(active.id)
    return {
      oauth: { ...grant, projectId: grant.projectId },
      accountId: active.id,
      ...grant.email === undefined ? {} : { email: grant.email },
      cca: runtime.cca,
    }
  }

  async hasReadyAccount(): Promise<boolean> {
    const accounts = await this.store.list()
    return accounts.some(account => account.projectId !== undefined)
  }

  noteRateLimited(accountId: string): void {
    const runtime = this.runtimeFor(accountId)
    runtime.limitedStrikes = (runtime.limitedStrikes ?? 0) + 1
    const cooldown = Math.min(
      RATE_LIMIT_COOLDOWN_MS * 2 ** (runtime.limitedStrikes - 1),
      RATE_LIMIT_COOLDOWN_MAX_MS,
    )
    runtime.limitedUntil = Date.now() + cooldown
  }

  noteAuthRejected(accountId: string): void {
    this.runtimeFor(accountId).dead = true
  }

  async snapshot(): Promise<AntigravityStatus> {
    const accounts = await this.summarizeAccounts()
    if (this.login.status === 'signing-in') {
      return { status: 'signing-in', ...this.login.url === undefined ? {} : { url: this.login.url }, accounts }
    }
    if (this.login.status === 'error' && accounts.length === 0) {
      return { status: 'error', message: this.login.message, accounts }
    }
    const active = await this.store.active()
    if (active === undefined) return { status: 'signed-out', accounts: [] }
    const ready = active.projectId !== undefined
    const message = this.serviceError ?? (ready
      ? undefined
      : 'Google authorization saved. Check Antigravity service eligibility to continue.')
    return {
      status: 'signed-in',
      activeId: active.id,
      accounts,
      ...message === undefined ? {} : { message },
    }
  }

  private async summarizeAccounts(): Promise<AccountSummary[]> {
    const all = await this.store.list()
    const active = await this.store.active()
    const now = Date.now()
    for (const account of all) {
      if (account.id === active?.id) continue
      if (account.expires >= now - OAUTH_REFRESH_SOON_MS) continue
      if ((this.precheckAt.get(account.id) ?? 0) > now - PRECHECK_INTERVAL_MS) continue
      this.precheckAt.set(account.id, now)
      if (this.precheckInFlight.has(account.id)) continue
      const task = this.precheckAccount(account.id).finally(() => {
        this.precheckInFlight.delete(account.id)
      })
      this.precheckInFlight.set(account.id, task)
    }
    return all.map((account) => {
      const runtime = this.runtimes.get(account.id)
      return {
        id: account.id,
        ...account.email === undefined ? {} : { email: account.email },
        ...account.projectId === undefined ? {} : { projectId: account.projectId },
        ...Number.isNaN(account.expires) ? {} : { expiresAt: new Date(account.expires).toISOString() },
        ready: account.projectId !== undefined,
        limited: runtime?.limitedUntil !== undefined && runtime.limitedUntil > now,
        dead: runtime?.dead === true,
      }
    })
  }

  private async precheckAccount(accountId: string): Promise<void> {
    try {
      const grant = await this.store.get(accountId)
      if (grant === undefined) return
      const next = await refreshAccessToken(grant, this.fetchImpl)
      await this.store.update(accountId, {
        access: next.access,
        refresh: next.refresh,
        expires: next.expires,
      })
      const runtime = this.runtimes.get(accountId)
      if (runtime !== undefined) runtime.dead = false
    } catch (error) {
      if (/invalid_grant/i.test(safeMessage(error))) this.runtimeFor(accountId).dead = true
      // network or proxy failures leave the account unknown; the next window retries
    }
  }

  async credential(): Promise<AntigravityOAuth | undefined> {
    const grant = await this.store.active()
    return grant?.projectId === undefined ? undefined : { ...grant, projectId: grant.projectId }
  }

  async refreshIfNeeded(now = Date.now()): Promise<AntigravityOAuth | undefined> {
    const grant = await this.refreshGrant(now)
    return grant?.projectId === undefined ? undefined : { ...grant, projectId: grant.projectId }
  }

  private async refreshGrant(now = Date.now()): Promise<AntigravityGrant | undefined> {
    const current = await this.store.active()
    if (current === undefined) return undefined
    if (now < current.expires - OAUTH_REFRESH_SOON_MS) return current
    if (now - (this.refreshAttempts.get(current.id) ?? 0) < OAUTH_REFRESH_COOLDOWN_MS) return current
    this.refreshAttempts.set(current.id, now)
    try {
      const next = await refreshAccessToken(current, this.fetchImpl, now)
      return await this.store.update(current.id, {
        access: next.access,
        refresh: next.refresh,
        expires: next.expires,
      })
    } catch (error) {
      if (/invalid_grant/i.test(safeMessage(error))) this.runtimeFor(current.id).dead = true
      return current
    }
  }

  async switchAccount(accountId: string): Promise<AntigravityStatus> {
    await this.store.setActive(accountId)
    return this.snapshot()
  }

  async removeAccount(accountId: string): Promise<AntigravityStatus> {
    await this.store.remove(accountId)
    this.runtimes.delete(accountId)
    this.precheckAt.delete(accountId)
    this.refreshAttempts.delete(accountId)
    return this.snapshot()
  }

  async signIn(): Promise<{ url: string }> {
    if (this.operation === undefined) this.startLogin()
    try {
      await this.listening
    } catch {
      await this.operation?.catch(() => undefined)
    }
    if (this.pendingUrl !== undefined && this.login.status === 'signing-in') return { url: this.pendingUrl }
    await this.operation?.catch(() => undefined)
    if (this.pendingUrl !== undefined && this.login.status === 'signing-in') return { url: this.pendingUrl }
    if (this.login.status === 'error') throw new Error(this.login.message)
    throw new Error('login did not produce an authorization URL')
  }

  async waitUntilSettled(): Promise<void> {
    await this.operation?.catch(() => undefined)
  }

  async complete(raw: string): Promise<AntigravityStatus> {
    if (!this.pendingState || this.completing) throw new Error('Start a new login before submitting a callback')
    const extracted = extractOAuthCode(raw)
    if (this.pendingState !== undefined && extracted.state !== undefined && extracted.state !== this.pendingState) {
      throw new Error('OAuth state mismatch')
    }
    const signal = this.cancellation!.signal
    this.completing = true
    try {
      await this.finishCode(extracted.code, signal)
    } finally {
      this.cancellation?.abort(new Error('Antigravity login completed'))
      await this.waitUntilSettled()
      this.completing = false
    }
    return this.snapshot()
  }

  private async finishCode(code: string, signal: AbortSignal): Promise<void> {
    this.serviceError = undefined
    try {
      const loginFetch: FetchImpl = (input, init) => this.fetchImpl(input, {
        ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      })
      const credential = await completeOAuthLogin(code, loginFetch, Date.now(), signal,
        async grant => { signal.throwIfAborted(); await this.store.add(grant) },
        summary => { this.eligibility = summary })
      signal.throwIfAborted()
      await this.store.add(credential)
      this.login = { status: 'idle' }
    } catch (error) {
      if (signal.aborted) return
      this.serviceError = safeMessage(error)
      const accounts = await this.store.list()
      if (accounts.length === 0) {
        this.login = { status: 'error', message: this.serviceError }
        return
      }
      // Eligibility failed for the freshly added account. Keep a working
      // account active instead of stranding requests on the broken one.
      const active = await this.store.active()
      if (active?.projectId === undefined) {
        const ready = accounts.find(account => account.projectId !== undefined)
        if (ready !== undefined) await this.store.setActive(ready.id)
      }
      this.login = { status: 'idle' }
    }
  }

  async retryEligibility(): Promise<AntigravityStatus> {
    if (this.operation) throw new Error('Cancel the active login before retrying eligibility')
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.operation = (async () => {
      try {
        const active = await this.store.active()
        const grant = await this.refreshGrant()
        if (active === undefined || grant === undefined) throw new Error('Sign in to Google first')
        const projectId = await discoverProject(grant.access, this.fetchImpl, cancellation.signal,
          summary => { this.eligibility = summary })
        cancellation.signal.throwIfAborted()
        await this.store.update(active.id, { projectId })
        this.serviceError = undefined
      } catch (error) {
        if (!cancellation.signal.aborted) this.serviceError = safeMessage(error)
      }
    })()
    try { await this.operation } finally { this.operation = undefined; this.cancellation = undefined }
    return this.snapshot()
  }

  async cancel(): Promise<void> {
    this.cancellation?.abort(new Error('Antigravity login cancelled'))
    await this.operation?.catch(() => undefined)
    await this.stopCallbackServer()
    this.pendingUrl = undefined
    this.pendingState = undefined
    this.login = { status: 'idle' }
  }

  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('Antigravity login cancelled'))
    await this.operation?.catch(() => undefined)
    await this.stopCallbackServer()
    const active = await this.store.active()
    if (active !== undefined) {
      await this.store.remove(active.id)
      this.runtimes.delete(active.id)
      this.precheckAt.delete(active.id)
      this.refreshAttempts.delete(active.id)
    }
    this.login = { status: 'idle' }
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
    await this.network.dispose()
  }

  private startLogin(): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    const state = newOAuthState()
    this.pendingState = state
    const url = authorizationUrl(state)
    if (!isSafeAuthUrl(url)) {
      this.login = { status: 'error', message: 'authorization URL is outside Google accounts' }
      return
    }
    this.pendingUrl = url
    this.login = { status: 'signing-in', url }
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
        this.completing = true
        await this.finishCode(hit.code, signal)
        const snapshot = await this.snapshot()
        const activeAccount = snapshot.status === 'signed-in'
          ? snapshot.accounts.find(account => account.id === snapshot.activeId)
          : undefined
        hit.reply(activeAccount?.ready === true, snapshot.status === 'signed-in')
      } catch (error: unknown) {
        hit.reply(false, false)
        throw error
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      this.login = { status: 'error', message: safeMessage(error) }
      console.error('[dsh-antigravity-oauth] login failed:', safeMessage(error))
    } finally {
      this.cancellation = undefined
      this.completing = false
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
  ): Promise<{ code: string, reply: (ok: boolean, authorized: boolean) => void }> {
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
          if (settled || this.completing) {
            if (!res.writableEnded) {
              res.writeHead(409, { 'content-type': 'text/plain' })
              res.end('already handled')
            }
            return
          }
          settled = true
          resolve({
            code,
            reply: (ok: boolean, authorized: boolean) => {
              if (res.writableEnded) return
              res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
              res.end(html(ok, authorized))
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
