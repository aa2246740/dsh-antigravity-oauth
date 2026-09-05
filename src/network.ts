import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { envProxyFetch, proxyUrlFor } from './proxy-fetch.ts'

export type NetworkSettings = { mode: 'auto' | 'direct' | 'proxy', url: string }
export const NETWORK_PATH = '/plugins/dsh-antigravity-oauth/network'

export function parseNetwork(value: unknown): NetworkSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid network settings')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(k => k !== 'mode' && k !== 'url')
    || !['auto', 'direct', 'proxy'].includes(String(data.mode)) || typeof data.url !== 'string') {
    throw new Error('Invalid network settings')
  }
  let url = ''
  if (data.url.trim()) {
    const parsed = new URL(data.url.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port === '0') {
      throw new Error('Use an HTTP(S) proxy URL without credentials or a path')
    }
    url = parsed.origin
  }
  if (data.mode === 'proxy' && !url) throw new Error('Proxy URL is required')
  return { mode: data.mode as NetworkSettings['mode'], url }
}

export class AntigravityNetwork {
  private agents = new Map<string, ProxyAgent>()
  constructor(readonly filename: string) {}
  async read(): Promise<NetworkSettings> {
    try { return parseNetwork(JSON.parse(await readFile(this.filename, 'utf8'))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'auto', url: '' }
      throw error
    }
  }
  async save(value: unknown): Promise<void> {
    const settings = parseNetwork(value)
    await writeFileAtomic(this.filename, JSON.stringify(settings) + '\n', { mode: 0o600, dirMode: 0o700 })
  }
  async snapshot() {
    const settings = await this.read()
    const proxy = settings.mode === 'proxy' ? settings.url
      : settings.mode === 'auto' ? proxyUrlFor('https://daily-cloudcode-pa.googleapis.com') : undefined
    // Hostname/port only. Environment proxy credentials must never reach the UI.
    const effective = proxy ? new URL(proxy).origin : 'direct'
    return { ...settings, effective }
  }
  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    // Model streams retain the adapter's idle timeout, not an auth deadline.
    if (!new URL(url).pathname.endsWith(':streamGenerateContent')) {
      const timeout = AbortSignal.timeout(30_000)
      init = { ...init, signal: upstream ? AbortSignal.any([upstream, timeout]) : timeout }
    }
    const settings = await this.read()
    if (settings.mode === 'auto') return envProxyFetch(input, init)
    if (settings.mode === 'direct') return fetch(input, init)
    let agent = this.agents.get(settings.url)
    if (!agent) { agent = new ProxyAgent(settings.url); this.agents.set(settings.url, agent) }
    return undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Response
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.agents.values()].map(agent => agent.close()))
  }
}
