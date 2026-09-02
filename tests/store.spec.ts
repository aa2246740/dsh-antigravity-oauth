import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AntigravityCredentialStore } from '../src/store.ts'

describe('AntigravityCredentialStore', () => {
  it('round-trips oauth with projectId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-'))
    const store = new AntigravityCredentialStore(join(dir, '.dsh-antigravity-oauth.json'))
    await store.write({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1_700_000_000_000,
      projectId: 'proj',
      email: 'dev@example.com',
    })
    const read = await store.read()
    expect(read).toEqual({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1_700_000_000_000,
      projectId: 'proj',
      email: 'dev@example.com',
    })
    expect(JSON.parse(await readFile(store.filename, 'utf8')).version).toBe(1)
  })

  it('refuses unknown fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-'))
    const store = new AntigravityCredentialStore(join(dir, 'auth.json'))
    await expect(store.write({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      projectId: 'p',
      extra: true,
    } as never)).rejects.toThrow(/unknown field/)
  })
})
