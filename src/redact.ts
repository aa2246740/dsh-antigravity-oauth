export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token|api[_-]?key|key)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 1000)
}

export function isSafeAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return host === 'accounts.google.com' || host.endsWith('.google.com')
  } catch {
    return false
  }
}
