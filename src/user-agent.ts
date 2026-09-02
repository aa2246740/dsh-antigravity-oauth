import { ANTIGRAVITY_VERSION_MANIFEST_URL, DEFAULT_ANTIGRAVITY_CL, DEFAULT_ANTIGRAVITY_VERSION } from './ids.ts'

let discoveredVersion: string | undefined
let inFlight: Promise<void> | undefined

export function parseAntigravityManifestVersion(yamlText: string): string | undefined {
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line)
    if (match === null) continue
    const version = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined
  }
  return undefined
}

export function getAntigravityVersion(): string {
  return process.env.DSH_ANTIGRAVITY_VERSION || discoveredVersion || DEFAULT_ANTIGRAVITY_VERSION
}

export function antigravityUserAgent(version = getAntigravityVersion()): string {
  const cl = process.env.DSH_ANTIGRAVITY_CL || DEFAULT_ANTIGRAVITY_CL
  const os = process.env.DSH_ANTIGRAVITY_OS || 'darwin'
  const arch = process.env.DSH_ANTIGRAVITY_ARCH || 'arm64'
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`
}

export function ensureAntigravityVersion(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  if (process.env.DSH_ANTIGRAVITY_VERSION || discoveredVersion !== undefined) return Promise.resolve()
  if (inFlight !== undefined) return inFlight
  inFlight = (async () => {
    try {
      const timeout = AbortSignal.timeout(5_000)
      const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'electron-builder' },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      if (response.ok) {
        discoveredVersion = parseAntigravityManifestVersion(await response.text())
      }
    } catch {
      /* pinned fallback stays valid */
    } finally {
      if (discoveredVersion === undefined) inFlight = undefined
    }
  })()
  return inFlight
}

export function resetAntigravityVersionForTests(): void {
  discoveredVersion = undefined
  inFlight = undefined
}
