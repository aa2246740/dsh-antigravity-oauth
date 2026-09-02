import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { createAntigravityAdapter } from './adapter.ts'
import { registerAntigravityAuthRoutes } from './auth-routes.ts'
import { HARNESS_ROUTE, OAUTH_REFRESH_POLL_MS } from './ids.ts'
import { maskDshWebAssembly } from './native-tools.ts'
import type { Config } from './plugin-config.ts'
import { AntigravitySession } from './session.ts'
import { AntigravityCredentialStore } from './store.ts'
import { ensureAntigravityVersion } from './user-agent.ts'

type NativeAssembly = {
  tools: { name: string }[]
  sections: { name: string, text: string }[]
}

type NativeAssembleContext = {
  agent?: { options?: { provider?: string } }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'system-prompt/assemble'(
      assembly: NativeAssembly,
      context: NativeAssembleContext,
      next: () => Promise<NativeAssembly>,
    ): Promise<NativeAssembly>
  }
}

export { createAntigravityAdapter } from './adapter.ts'
export {
  registerAntigravityAuthRoutes,
} from './auth-routes.ts'
export { AUTH_COMPLETE_PATH, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH, AUTH_STATUS_PATH, AUTH_FILENAME, BOOT_MARKER, HARNESS_ROUTE } from './ids.ts'
export { Config } from './plugin-config.ts'
export type { Config as PluginConfig } from './plugin-config.ts'
export { AntigravitySession } from './session.ts'
export { AntigravityCredentialStore, antigravityAuthPath } from './store.ts'
export { authorizationUrl, LOAD_CODE_ASSIST_BODY, SCOPES } from './oauth.ts'
export { buildCcaBody, createCcaSession, streamGenerateContentUrl } from './envelope.ts'
export { CcaClient } from './cca-client.ts'
export type { AntigravityOAuth, CcaKind, CcaSession } from './types.ts'

export const name = 'llm-antigravity-oauth'
export const inject = ['llm']

async function syncAuthenticatedRoute(
  session: AntigravitySession,
  registration: AdapterRegistrationHandle,
): Promise<void> {
  const credential = await session.credential()
  registration.replace(credential === undefined ? [] : [HARNESS_ROUTE])
}

export function apply(ctx: Context, config: Config): void {
  console.log('[my-plugins/dsh-antigravity-oauth] loaded')
  const session = new AntigravitySession(new AntigravityCredentialStore())
  const registration = ctx.llm.registerAdapter(
    [HARNESS_ROUTE],
    createAntigravityAdapter(session, {
      nativeTools: config.nativeTools !== false,
      nativeImage: config.nativeImage !== false,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      resolveAttachments: () => ctx.get('attachments'),
    }),
  )
  const refreshRoutes = (): Promise<void> => syncAuthenticatedRoute(session, registration)
  void refreshRoutes()
  void ensureAntigravityVersion()
  ctx.effect(() => {
    const timer = setInterval(() => {
      void session.refreshIfNeeded().catch(() => { /* next poll retries */ })
    }, OAUTH_REFRESH_POLL_MS)
    void session.refreshIfNeeded().catch(() => { /* next poll retries */ })
    return () => clearInterval(timer)
  }, 'dsh-antigravity-oauth: refresh oauth grant')
  ctx.inject(['webServer'], webCtx => {
    registerAntigravityAuthRoutes(webCtx, session, { onAuthChanged: refreshRoutes })
  })
  if (config.nativeTools !== false) {
    ctx.inject(['systemPrompt'], promptCtx => {
      promptCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next()
        return context.agent?.options?.provider === HARNESS_ROUTE
          ? maskDshWebAssembly(assembled)
          : assembled
      })
    })
  }
}
