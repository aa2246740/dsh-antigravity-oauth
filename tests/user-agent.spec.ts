import { describe, expect, it } from 'vitest'
import { antigravityUserAgent, parseAntigravityManifestVersion } from '../src/user-agent.ts'
import { DEFAULT_ANTIGRAVITY_CL, DEFAULT_ANTIGRAVITY_VERSION } from '../src/ids.ts'

describe('user agent', () => {
  it('matches antigravity/hub format with pinned fallback', () => {
    const ua = antigravityUserAgent(DEFAULT_ANTIGRAVITY_VERSION)
    expect(ua).toBe(
      `antigravity/hub/${DEFAULT_ANTIGRAVITY_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=${DEFAULT_ANTIGRAVITY_CL})`,
    )
  })

  it('parses electron-builder manifest version', () => {
    expect(parseAntigravityManifestVersion('version: 2.12.0\npath: foo')).toBe('2.12.0')
  })
})
