import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AntigravityCredentialStore } from '../src/store.ts'
import { AntigravitySession } from '../src/session.ts'
import { CALLBACK_URI } from '../src/ids.ts'
import { AntigravityNetwork, parseNetwork } from '../src/network.ts'

async function store() {
  return new AntigravityCredentialStore(join(await mkdtemp(join(tmpdir(), 'agy-recovery-')), 'auth.json'))
}

describe('OAuth recovery across callback, storage and service eligibility', () => {
  it('saves Google authorization on rejection, survives reload and retries without exchanging the code again', async () => {
    const credentialStore = await store()
    let eligible = false
    let exchanges = 0
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      if (url.includes('manifest/')) return new Response('', { status: 503 })
      if (url.endsWith('/token')) {
        exchanges++
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 7200 })
      }
      if (url.includes('userinfo')) return Response.json({ email: 'fixture@example.test' })
      if (url.includes('loadCodeAssist')) return Response.json(eligible
        ? { paidTier: { id: 'pro' }, cloudaicompanionProject: { id: 'fixture-project' } }
        : { ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'Location unavailable' }] })
      throw new Error('Unexpected request: ' + new URL(url).pathname)
    }
    const session = new AntigravitySession(credentialStore, fetcher)
    try {
      const challenge = await session.signIn()
      const state = new URL(challenge.url).searchParams.get('state')!
      const response = await fetch(`${CALLBACK_URI}?code=fixture-code&state=${state}`)
      expect(response.status).toBe(400)
      await session.waitUntilSettled()
      expect(await session.snapshot()).toMatchObject({ status: 'signed-in', message: 'Location unavailable' })
      expect(await session.credential()).toBeUndefined()
      expect((await credentialStore.list())[0]?.refresh).toBe('fixture-refresh')
      await session.dispose()
      const restored = new AntigravitySession(credentialStore, fetcher)
      try {
        expect(await restored.snapshot()).toMatchObject({ status: 'signed-in' })
        eligible = true
        expect(await restored.retryEligibility()).toMatchObject({
          status: 'signed-in',
          accounts: [{ projectId: 'fixture-project' }],
        })
        expect(exchanges).toBe(1)
      } finally { await restored.dispose() }
    } finally { await session.dispose() }
  })

  it('cancels login, closes the callback port, preserves the grant and permits another login', async () => {
    const credentialStore = await store()
    const grant = { type: 'oauth' as const, access: 'fixture-a', refresh: 'fixture-r', expires: Date.now() + 7200000 }
    await credentialStore.add(grant)
    const session = new AntigravitySession(credentialStore, async () => new Response('', { status: 503 }))
    try {
      await session.signIn()
      await session.cancel()
      expect(await session.snapshot()).toMatchObject({ status: 'signed-in' })
      expect(await credentialStore.list()).toHaveLength(1)
      expect((await credentialStore.list())[0]).toMatchObject(grant)
      await expect(fetch(CALLBACK_URI)).rejects.toThrow()
      expect((await session.signIn()).url).toContain('accounts.google.com')
      await session.cancel()
      await expect(session.complete('old-code')).rejects.toThrow('Start a new login')
    } finally { await session.dispose() }
  })

  it('keeps a working account active when a second login fails eligibility', async () => {
    const credentialStore = await store()
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      if (url.includes('manifest/')) return new Response('', { status: 503 })
      if (url.endsWith('/token')) {
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 7200 })
      }
      if (url.includes('userinfo')) return Response.json({ email: 'fixture@example.test' })
      if (url.includes('loadCodeAssist')) return Response.json({ paidTier: { id: 'pro' }, cloudaicompanionProject: { id: 'fixture-project' } })
      throw new Error('Unexpected request: ' + new URL(url).pathname)
    }
    const working = { type: 'oauth' as const, access: 'ok', refresh: 'ok-r', expires: Date.now() + 7200000, projectId: 'ok-project', email: 'ok@example.test' }
    await credentialStore.add(working)
    const session = new AntigravitySession(credentialStore, async input => {
      const url = String(input)
      if (url.includes('userinfo')) return Response.json({ email: 'broken@example.test' })
      if (url.endsWith('/token')) {
        return Response.json({ access_token: 'broken-a', refresh_token: 'broken-r', expires_in: 7200 })
      }
      if (url.includes('loadCodeAssist')) {
        return Response.json({ ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'Location unavailable' }] })
      }
      throw new Error('Unexpected request: ' + new URL(url).pathname)
    })
    try {
      const challenge = await session.signIn()
      const state = new URL(challenge.url).searchParams.get('state')!
      await fetch(`${CALLBACK_URI}?code=fixture-code&state=${state}`)
      await session.waitUntilSettled()
      const accounts = await credentialStore.list()
      expect(accounts).toHaveLength(2)
      const active = await credentialStore.active()
      expect(active?.projectId).toBe('ok-project')
    } finally { await session.dispose() }
  })
})

describe('plugin-owned network settings', () => {
  it('persists an explicit proxy independently and reports its effective route', async () => {
    const credentialStore = await store()
    const network = new AntigravityNetwork(credentialStore.filename + '.network.json')
    await network.save({ mode: 'proxy', url: 'http://127.0.0.1:45678' })
    expect(await new AntigravityNetwork(network.filename).snapshot()).toEqual({
      mode: 'proxy', url: 'http://127.0.0.1:45678', effective: 'http://127.0.0.1:45678',
    })
  })
  it.each(['http://user:secret@localhost:45678', 'socks5://localhost:45678', 'http://localhost/path', 'http://localhost/?token=secret'])('rejects unsafe proxy %s', url => {
    expect(() => parseNetwork({ mode: 'proxy', url })).toThrow()
  })
})
