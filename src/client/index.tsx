import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AntigravitySettings } from './Settings.tsx'
import type { AntigravitySettingsInjected } from './Settings.tsx'
import { en, zh } from './locales.ts'
import type { AntigravityKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.antigravity-oauth': AntigravityKey
  }
}

export const name = 'dsh-antigravity-oauth-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.antigravity-oauth'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-antigravity-oauth: settings copy')
  const t = ctx.locale.bind(namespace) as AntigravitySettingsInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'antigravity-oauth',
    order: 18,
    label: () => t('nav'),
    inject: (): AntigravitySettingsInjected => ({ t }),
  }, AntigravitySettings))
}
