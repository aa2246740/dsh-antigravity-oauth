import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AntigravityCredentialStore } from '../src/store.ts'

const grant = {
  type: 'oauth' as const,
  access: 'a',
  refresh: 'r',
  expires: 1_700_000_000_000,
  projectId: 'proj',
  email: 'dev@example.com',
}

async function store() {
  return new AntigravityCredentialStore(join(await mkdtemp(join(tmpdir(), 'dsh-agy-')), 'auth.json'))
}

describe('AntigravityCredentialStore', () => {
  it('adds accounts, activates the newest one and writes the v2 format', async () => {
    const credentialStore = await store()
    const first = await credentialStore.add(grant)
    expect(first.id).toMatch(/^acc_/)
    expect(first.addedAt).toBeTruthy()
    const second = await credentialStore.add({ ...grant, refresh: 'r2', email: 'dev2@example.com' })
    expect(second.id).not.toBe(first.id)
    expect(await credentialStore.list()).toHaveLength(2)
    expect(await credentialStore.active()).toMatchObject({ refresh: 'r2' })
    expect(JSON.parse(await readFile(credentialStore.filename, 'utf8')).version).toBe(2)
  })

  it('migrates a v1 file, keeps the credential and writes a one-time backup', async () => {
    const credentialStore = await store()
    await writeFile(credentialStore.filename, `${JSON.stringify({ version: 1, credential: grant })}\n`, { mode: 0o600 })
    expect(await credentialStore.list()).toEqual([{ ...grant, id: 'acc_default' }])
    expect(await credentialStore.active()).toMatchObject({ refresh: 'r' })
    await credentialStore.add({ ...grant, refresh: 'r2', email: 'dev2@example.com' })
    const migrated = JSON.parse(await readFile(credentialStore.filename, 'utf8'))
    expect(migrated.version).toBe(2)
    expect(migrated.activeId).toBe(migrated.accounts[1]?.id)
    expect(migrated.accounts[0]).toMatchObject({ id: 'acc_default', refresh: 'r' })
    const backup = JSON.parse(await readFile(credentialStore.filename + '.v1.bak', 'utf8'))
    expect(backup).toEqual({ version: 1, credential: grant })
  })

  it('replaces the stored account in place when the same email signs in again', async () => {
    const credentialStore = await store()
    const first = await credentialStore.add(grant)
    const again = await credentialStore.add({ ...grant, access: 'a2', refresh: 'r2' })
    expect(await credentialStore.list()).toHaveLength(1)
    expect(again.id).toBe(first.id)
    expect((await credentialStore.active())?.refresh).toBe('r2')
  })

  it('caps the pool at ten accounts', async () => {
    const credentialStore = await store()
    for (let index = 0; index < 10; index += 1) {
      await credentialStore.add({ ...grant, refresh: `r${index}`, email: `dev${index}@example.com` })
    }
    await expect(credentialStore.add({ ...grant, refresh: 'r11', email: 'dev11@example.com' }))
      .rejects.toThrow(/at most 10/)
  })

  it('removes accounts and falls back from the active one to the first remaining', async () => {
    const credentialStore = await store()
    const first = await credentialStore.add(grant)
    const second = await credentialStore.add({ ...grant, refresh: 'r2', email: 'dev2@example.com' })
    const removed = await credentialStore.remove(second.id)
    expect(removed.refresh).toBe('r2')
    expect((await credentialStore.active())?.id).toBe(first.id)
    await credentialStore.remove(first.id)
    expect(await credentialStore.list()).toEqual([])
    expect(await credentialStore.active()).toBeUndefined()
  })

  it('updates tokens for one account without touching the others', async () => {
    const credentialStore = await store()
    const first = await credentialStore.add(grant)
    await credentialStore.add({ ...grant, refresh: 'r2', email: 'dev2@example.com' })
    const updated = await credentialStore.update(first.id, { access: 'a3', refresh: 'r3', expires: 1_800_000_000_000 })
    expect(updated.refresh).toBe('r3')
    expect(updated.projectId).toBe('proj')
    const all = await credentialStore.list()
    expect(all[0]?.refresh).toBe('r3')
    expect(all[1]?.refresh).toBe('r2')
  })

  it('refuses unknown fields and unknown account ids', async () => {
    const credentialStore = await store()
    await expect(credentialStore.add({ ...grant, extra: true } as never)).rejects.toThrow(/unknown field/)
    await credentialStore.add(grant)
    await expect(credentialStore.setActive('acc_missing')).rejects.toThrow(/unknown account/)
    await expect(credentialStore.remove('acc_missing')).rejects.toThrow(/unknown account/)
    await expect(credentialStore.update('acc_missing', { access: 'x' })).rejects.toThrow(/unknown account/)
  })

  it('fails closed on a v2 document with a dangling activeId', async () => {
    const credentialStore = await store()
    await credentialStore.add(grant)
    await writeFile(
      credentialStore.filename,
      `${JSON.stringify({ version: 2, activeId: 'acc_ghost', accounts: [{ ...grant, id: 'acc_a' }] })}\n`,
      { mode: 0o600 },
    )
    await expect(credentialStore.list()).rejects.toThrow(/activeId/)
  })
})
