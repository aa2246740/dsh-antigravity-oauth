import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AntigravitySession } from '../src/session.ts'
import { AntigravityCredentialStore } from '../src/store.ts'
import { authorizationUrl } from '../src/oauth.ts'

describe('AntigravitySession login URL', () => {
  it('returns a Google authorization URL without PKCE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-auth-'))
    const session = new AntigravitySession(new AntigravityCredentialStore(join(dir, 'auth.json')), async () => {
      throw new Error('network disabled')
    })
    try {
      const challenge = await session.signIn()
      expect(challenge.url).not.toContain('code_challenge')
      expect(challenge.url).not.toContain('aicode')
      expect(new URL(challenge.url).hostname).toBe('accounts.google.com')
      expect(challenge.url.startsWith(authorizationUrl(new URL(challenge.url).searchParams.get('state') ?? '').slice(0, 40))).toBe(true)
    } finally {
      await session.dispose()
    }
  })

  it('waitUntilSettled resolves after login is cancelled so route refresh can run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-auth-'))
    const session = new AntigravitySession(new AntigravityCredentialStore(join(dir, 'auth.json')), async () => {
      throw new Error('network disabled')
    })
    try {
      await session.signIn()
      const settled = session.waitUntilSettled()
      await session.dispose()
      await expect(settled).resolves.toBeUndefined()
    } finally {
      await session.dispose()
    }
  })
})
