import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CALLBACK_URI, TOKEN_URL } from '../src/ids.ts'
import { AntigravitySession } from '../src/session.ts'
import { AntigravityCredentialStore } from '../src/store.ts'
import { authorizationUrl } from '../src/oauth.ts'

async function sessionWithStore(fetchImpl: typeof fetch): Promise<{
  session: AntigravitySession
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-auth-'))
  return { dir, session: new AntigravitySession(new AntigravityCredentialStore(join(dir, 'auth.json')), fetchImpl) }
}

async function waitForCallbackPort(): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      await fetch('http://127.0.0.1:51121/favicon.ico')
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  throw new Error('callback server did not listen on 51121')
}

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

describe('AntigravitySession login after logout', () => {
  it('starts a new authorization after signOut', async () => {
    const { session } = await sessionWithStore(async () => {
      throw new Error('network disabled')
    })
    try {
      const first = await session.signIn()
      await session.signOut()
      expect(await session.snapshot()).toEqual({ status: 'signed-out' })
      const second = await session.signIn()
      expect(new URL(second.url).hostname).toBe('accounts.google.com')
      expect(new URL(second.url).searchParams.get('state')).not.toBe(new URL(first.url).searchParams.get('state'))
      expect((await session.snapshot()).status).toBe('signing-in')
    } finally {
      await session.dispose()
    }
  })

  it('surfaces token-exchange failure instead of falling back to signed-out', async () => {
    const { session } = await sessionWithStore(async (input) => {
      const url = String(input)
      if (url.startsWith(TOKEN_URL)) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code already used' }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      const challenge = await session.signIn()
      await waitForCallbackPort()
      const state = new URL(challenge.url).searchParams.get('state')
      expect(state).toBeTruthy()
      const callback = fetch(`${CALLBACK_URI}?code=fake-code&state=${state}`)
      await session.waitUntilSettled()
      const page = await callback
      const snap = await session.snapshot()
      expect(snap.status).toBe('error')
      if (snap.status === 'error') {
        expect(snap.message).toMatch(/token exchange failed|invalid_grant/i)
      }
      expect(page.ok).toBe(false)
    } finally {
      await session.dispose()
    }
  })

  it('does not abort login when the browser also requests favicon', async () => {
    const { session } = await sessionWithStore(async () => {
      throw new Error('network disabled')
    })
    try {
      await session.signIn()
      await waitForCallbackPort()
      const favicon = await fetch('http://127.0.0.1:51121/favicon.ico')
      expect(favicon.status).toBe(404)
      expect((await session.snapshot()).status).toBe('signing-in')
    } finally {
      await session.dispose()
    }
  })
})
