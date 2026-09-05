import { useCallback, useEffect, useState } from 'react'
import type { AntigravityKey } from './locales.ts'
import type { AntigravityAccountState as AccountState } from '../types.ts'

const STATUS_PATH = '/plugins/dsh-antigravity-oauth/auth/status'
const LOGIN_PATH = '/plugins/dsh-antigravity-oauth/auth/login'
const COMPLETE_PATH = '/plugins/dsh-antigravity-oauth/auth/complete'
const LOGOUT_PATH = '/plugins/dsh-antigravity-oauth/auth/logout'
const POLL_INTERVAL_MS = 1_000
const STYLE_ID = 'dsh-antigravity-oauth-settings-theme'

const NETWORK_PATH = '/plugins/dsh-antigravity-oauth/network'
type Network = { mode: 'auto' | 'direct' | 'proxy', url: string, effective: string }

export interface AntigravitySettingsInjected {
  t: (key: AntigravityKey, params?: Record<string, unknown>) => string
}

export type AntigravitySettingsProps = Partial<AntigravitySettingsInjected>

const SETTINGS_CSS = `
.dsh-agy-page { display:flex; flex-direction:column; gap:16px; max-width:640px; color:var(--dsw-alias-label-primary); }
.dsh-agy-title { margin:0; font-size:20px; line-height:28px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-agy-body { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); }
.dsh-agy-error { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-state-error-primary); }
.dsh-agy-card {
  display:flex; flex-direction:column; gap:8px; padding:14px 16px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-module-platform);
}
.dsh-agy-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.dsh-agy-name { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-agy-status { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dsh-agy-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:var(--dsw-alias-label-dimmed, #9aa0a6); }
.dsh-agy-dot.is-signed-in { background:var(--dsw-alias-state-success-primary, #22a06b); }
.dsh-agy-dot.is-error { background:var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-agy-dot.is-signing-in { background:var(--dsw-alias-brand-primary, #1677ff); }
.dsh-agy-btn {
  box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
  min-height:32px; padding:4px 14px; border-radius:16px; font:inherit; font-size:13px; line-height:20px; cursor:pointer;
}
.dsh-agy-btn:disabled { opacity:0.55; cursor:not-allowed; }
.dsh-agy-btn-secondary {
  border:1px solid var(--dsw-alias-border-l2);
  background:transparent;
  color:var(--dsw-alias-label-primary);
}
.dsh-agy-btn-primary {
  border:none;
  background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-agy-link { color:var(--dsw-alias-brand-primary); word-break:break-all; }
.dsh-agy-form { display:flex; flex-direction:column; gap:8px; }
.dsh-agy-input {
  box-sizing:border-box; width:100%; min-height:36px; padding:7px 10px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
  background:var(--dsw-alias-bg-page-primary, transparent);
  color:var(--dsw-alias-label-primary); font:inherit; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsh-agy-actions { display:flex; justify-content:flex-end; }
`

function ensureThemeStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = SETTINGS_CSS
  document.head.appendChild(style)
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    credentials: 'same-origin',
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

export function AntigravitySettings({ t }: AntigravitySettingsProps) {
  if (t === undefined) throw new Error('Antigravity settings requires its translation function')
  const [account, setAccount] = useState<AccountState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [network, setNetwork] = useState<Network>()
  const [networkMessage, setNetworkMessage] = useState('')

  useEffect(() => { ensureThemeStyles() }, [])

  const refresh = useCallback(async () => {
    try {
      setAccount(await jsonRequest<AccountState>(STATUS_PATH))
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    void jsonRequest<Network>(NETWORK_PATH).then(setNetwork).catch(error => setError(String(error)))
  }, [])
  const signing = account?.status === 'signing-in'
  useEffect(() => {
    if (!signing) return
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh, signing])

  const signIn = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setBusy(true)
    try {
      const challenge = await jsonRequest<{ url: string }>(LOGIN_PATH, 'POST', {})
      if (popup !== null && challenge.url !== undefined) popup.location.replace(challenge.url)
      if (popup === null && challenge.url !== undefined) window.open(challenge.url, '_blank', 'noopener,noreferrer')
      if (popup !== null && challenge.url === undefined) popup.close()
      await refresh()
    } catch (caught: unknown) {
      popup?.close()
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  const complete = async (): Promise<void> => {
    const value = draft.trim()
    if (value.length === 0) return
    setBusy(true)
    try {
      await jsonRequest<{ ok: true }>(COMPLETE_PATH, 'POST', { url: value })
      setDraft('')
      await refresh()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      await jsonRequest<{ ok: true }>(LOGOUT_PATH, 'POST', {})
      await refresh()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  const recover = async (action: 'cancel' | 'retry'): Promise<void> => {
    setBusy(true)
    try {
      await jsonRequest(`/plugins/dsh-antigravity-oauth/auth/${action}`, 'POST', {})
      setDraft('')
      await refresh()
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }

  const saveNetwork = async (): Promise<void> => {
    if (!network) return
    setBusy(true)
    try {
      setNetwork(await jsonRequest<Network>(NETWORK_PATH, 'POST', { mode: network.mode, url: network.url }))
      setNetworkMessage(t('networkSaved'))
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }

  const label = account === undefined
    ? t('loadingAccount')
    : account.status === 'signed-in'
      ? t('signedIn')
      : account.status === 'authorized'
        ? t('authorized')
      : account.status === 'signing-in'
        ? t('signingIn')
        : account.status === 'error'
          ? t('requestFailed')
          : t('signedOut')
  const dotClass = account?.status === 'signed-in'
    ? 'dsh-agy-dot is-signed-in'
    : account?.status === 'error'
      ? 'dsh-agy-dot is-error'
      : account?.status === 'signing-in'
        ? 'dsh-agy-dot is-signing-in'
        : 'dsh-agy-dot'

  return (
    <section className="dsh-agy-page" aria-labelledby="antigravity-settings-title">
      <h2 id="antigravity-settings-title" className="dsh-agy-title">{t('title')}</h2>
      <p className="dsh-agy-body">{t('tos')}</p>
      {error !== undefined ? <p className="dsh-agy-error">{error}</p> : null}
      {network && <div className="dsh-agy-card">
        <p className="dsh-agy-name">{t('network')}</p>
        <p className="dsh-agy-body">{t('networkHelp')}</p>
        <label>{t('network')} <select aria-label={t('network')} value={network.mode} disabled={busy}
          onChange={e => setNetwork({ ...network, mode: e.target.value as Network['mode'] })}>
          <option value="auto">{t('networkAuto')}</option>
          <option value="direct">{t('networkDirect')}</option>
          <option value="proxy">{t('networkProxy')}</option>
        </select></label>
        {network.mode === 'proxy' && <input className="dsh-agy-input" aria-label={t('proxyUrl')}
          placeholder="http://127.0.0.1:45678" value={network.url} disabled={busy}
          onChange={e => setNetwork({ ...network, url: e.target.value })} />}
        <p className="dsh-agy-body">{t('effectiveNetwork')} {network.effective}</p>
        <button className="dsh-agy-btn dsh-agy-btn-secondary" disabled={busy} onClick={() => { void saveNetwork() }}>{t('saveNetwork')}</button>
        {networkMessage && <p role="status">{networkMessage}</p>}
      </div>}
      <article className="dsh-agy-card">
        <div className="dsh-agy-row">
          <p className="dsh-agy-name">{t('title')}</p>
          {account?.status === 'signed-in' || account?.status === 'authorized'
            ? (
                <button type="button" className="dsh-agy-btn dsh-agy-btn-secondary" disabled={busy} onClick={() => { void signOut() }}>
                  {busy ? t('working') : t('logout')}
                </button>
              )
            : account?.status === 'signing-in' ? (
                <button type="button" className="dsh-agy-btn dsh-agy-btn-secondary" onClick={() => { void recover('cancel') }}>{t('cancel')}</button>
              ) : (
                <button type="button" className="dsh-agy-btn dsh-agy-btn-primary" disabled={busy} onClick={() => { void signIn() }}>
                  {busy ? t('working') : account?.status === 'error' ? t('loginAgain') : t('login')}
                </button>
              )}
        </div>
        <div className="dsh-agy-status" role="status">
          <span aria-hidden="true" className={dotClass} />
          <span>{label}</span>
        </div>
        {account?.status === 'error' ? <p className="dsh-agy-error">{account.message}</p> : null}
        {account?.status === 'authorized' && <>
          <p className="dsh-agy-body">{t('authorizedHelp')}</p>
          <p className="dsh-agy-error">{account.message}</p>
          <button type="button" className="dsh-agy-btn dsh-agy-btn-primary" disabled={busy}
            onClick={() => { void recover('retry') }}>{busy ? t('working') : t('retryEligibility')}</button>
          {busy && <button type="button" className="dsh-agy-btn dsh-agy-btn-secondary"
            onClick={() => { void recover('cancel') }}>{t('cancel')}</button>}
        </>}
        {account?.status === 'signed-in' && account.email !== undefined
          ? <p className="dsh-agy-body">{t('email')} {account.email}</p>
          : null}
        {account?.status === 'signed-in'
          ? <p className="dsh-agy-body">{t('project')} {account.projectId}</p>
          : null}
        {account?.status === 'signing-in' && account.url !== undefined
          ? (
              <p className="dsh-agy-body">
                {t('openUrl')}
                {' '}
                <a href={account.url} target="_blank" rel="noreferrer" className="dsh-agy-link">{t('reopen')}</a>
              </p>
            )
          : null}
        {account?.status === 'signing-in'
          ? (
              <form
                className="dsh-agy-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void complete()
                }}
              >
                <p className="dsh-agy-body">{t('completeHelp')}</p>
                <input
                  type="text"
                  className="dsh-agy-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('completePlaceholder')}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => { setDraft(event.target.value) }}
                />
                <div className="dsh-agy-actions">
                  <button type="submit" className="dsh-agy-btn dsh-agy-btn-primary" disabled={busy || draft.trim().length === 0}>
                    {busy ? t('working') : t('complete')}
                  </button>
                </div>
              </form>
            )
          : null}
      </article>
    </section>
  )
}
