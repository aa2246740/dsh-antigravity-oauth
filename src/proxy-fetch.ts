import { ProxyAgent, fetch as undiciFetch } from 'undici'

const agents = new Map<string, ProxyAgent>()

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

function noProxyList(): string[] {
  const raw = firstEnv(['NO_PROXY', 'no_proxy']) ?? ''
  return raw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

function hostMatchesNoProxy(host: string, pattern: string): boolean {
  const lowerHost = host.toLowerCase()
  const lower = pattern.toLowerCase()
  if (lower === '*') return true
  if (lower.startsWith('.')) return lowerHost === lower.slice(1) || lowerHost.endsWith(lower)
  return lowerHost === lower || lowerHost.endsWith(`.${lower}`)
}

export function proxyUrlFor(target: string): string | undefined {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return undefined
  }
  if (noProxyList().some(pattern => hostMatchesNoProxy(url.hostname, pattern))) return undefined
  if (url.protocol === 'https:') {
    return firstEnv(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'])
  }
  if (url.protocol === 'http:') {
    return firstEnv(['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])
  }
  return undefined
}

function agentFor(proxy: string): ProxyAgent {
  const existing = agents.get(proxy)
  if (existing !== undefined) return existing
  const agent = new ProxyAgent(proxy)
  agents.set(proxy, agent)
  return agent
}

export async function envProxyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  const proxy = proxyUrlFor(url)
  if (proxy === undefined) return fetch(input, init)
  return undiciFetch(url, { ...init, dispatcher: agentFor(proxy) } as Parameters<typeof undiciFetch>[1]) as unknown as Response
}
