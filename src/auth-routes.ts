import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AUTH_COMPLETE_PATH, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH, AUTH_STATUS_PATH } from './ids.ts'
import { isSafeAuthUrl, safeMessage } from './redact.ts'
import type { AntigravitySession } from './session.ts'
import { NETWORK_PATH } from './network.ts'

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function codeFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new Error('expected a JSON object')
  if ('code' in value && typeof value.code === 'string') return value.code
  if ('url' in value && typeof value.url === 'string') return value.url
  if ('value' in value && typeof value.value === 'string') return value.value
  throw new Error('expected { "code": "..." } or { "url": "..." }')
}

export interface AuthRouteOptions {
  onAuthChanged?: () => void | Promise<void>
}

export function registerAntigravityAuthRoutes(
  ctx: Context,
  session: AntigravitySession,
  options: AuthRouteOptions = {},
): void {
  const notify = async (): Promise<void> => {
    await options.onAuthChanged?.()
  }
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact', path: NETWORK_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          const hostname = new URL(`http://${req.headers.host}`).hostname
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return json(res, 403, { error: 'forbidden' })
          try {
            if (req.method === 'GET') return json(res, 200, await session.network.snapshot())
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'application/json required' })
            await session.network.save(await readJson(req))
            json(res, 200, await session.network.snapshot())
          } catch (error) { json(res, 400, { error: safeMessage(error) }) }
        },
      }),
      ...(['cancel', 'retry'] as const).map(action => ctx.webServer.register({
        kind: 'exact', path: `/plugins/dsh-antigravity-oauth/auth/${action}`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            if (action === 'cancel') await session.cancel()
            else await session.retryEligibility()
            await notify()
            json(res, 200, { ok: true, account: await session.snapshot() })
          } catch (error) { json(res, 500, { error: safeMessage(error) }) }
        },
      })),
      ctx.webServer.register({
        kind: 'exact',
        path: AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          json(res, 200, await session.snapshot())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            const challenge = await session.signIn()
            if (!isSafeAuthUrl(challenge.url)) throw new Error('authorization URL is outside Google accounts')
            json(res, 200, challenge)
            void session.waitUntilSettled().then(async () => {
              await notify()
            })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: AUTH_COMPLETE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            const account = await session.complete(codeFrom(await readJson(req)))
            await notify()
            json(res, 200, { ok: true, account })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            await session.signOut()
            await notify()
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      await session.dispose()
    }
  }, 'dsh-antigravity-oauth: Web OAuth routes')
}
