import { copyFile, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { AUTH_FILENAME } from './ids.ts'
import type { AntigravityGrant } from './types.ts'
import { isRecord } from './types.ts'

const AUTH_FORMAT_VERSION = 2
const LEGACY_FORMAT_VERSION = 1
const BACKUP_SUFFIX = '.v1.bak'
const MAX_ACCOUNTS = 10
const MIGRATED_ACCOUNT_ID = 'acc_default'
const OAUTH_FIELDS = new Set(['type', 'access', 'refresh', 'expires', 'projectId', 'email'])
const ACCOUNT_FIELDS = new Set([...OAUTH_FIELDS, 'id', 'addedAt'])

export type StoredAccount = AntigravityGrant & { id: string, addedAt?: string }

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  activeId?: string
  accounts: StoredAccount[]
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  if (process.platform === 'win32') return
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `dsh-antigravity-oauth: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
}

export function parseAntigravityOAuth(raw: unknown, filename: string): AntigravityGrant {
  if (!isRecord(raw)) throw new Error(`dsh-antigravity-oauth: ${filename} credential must be an object`)
  if (raw.type !== 'oauth') throw new Error(`dsh-antigravity-oauth: ${filename} credential type must be oauth`)
  if (Object.keys(raw).some(key => !OAUTH_FIELDS.has(key))) {
    throw new Error(`dsh-antigravity-oauth: ${filename} credential contains an unknown field`)
  }
  if (typeof raw.access !== 'string' || raw.access.length === 0) {
    throw new Error(`dsh-antigravity-oauth: ${filename} access must be a non-empty string`)
  }
  if (typeof raw.refresh !== 'string' || raw.refresh.length === 0) {
    throw new Error(`dsh-antigravity-oauth: ${filename} refresh must be a non-empty string`)
  }
  if (typeof raw.expires !== 'number' || !Number.isFinite(raw.expires) || raw.expires <= 0) {
    throw new Error(`dsh-antigravity-oauth: ${filename} expires must be a positive finite number`)
  }
  if (raw.projectId !== undefined && (typeof raw.projectId !== 'string' || raw.projectId.length === 0)) {
    throw new Error(`dsh-antigravity-oauth: ${filename} projectId must be a non-empty string`)
  }
  if (raw.email !== undefined && typeof raw.email !== 'string') {
    throw new Error(`dsh-antigravity-oauth: ${filename} email must be a string`)
  }
  return {
    type: 'oauth',
    access: raw.access,
    refresh: raw.refresh,
    expires: raw.expires,
    ...typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {},
    ...typeof raw.email === 'string' ? { email: raw.email } : {},
  }
}

function parseAccount(raw: unknown, filename: string): StoredAccount {
  if (!isRecord(raw)) throw new Error(`dsh-antigravity-oauth: ${filename} account must be an object`)
  if (Object.keys(raw).some(key => !ACCOUNT_FIELDS.has(key))) {
    throw new Error(`dsh-antigravity-oauth: ${filename} account contains an unknown field`)
  }
  const grant = parseAntigravityOAuth({
    type: raw.type,
    access: raw.access,
    refresh: raw.refresh,
    expires: raw.expires,
    projectId: raw.projectId,
    email: raw.email,
  }, filename)
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error(`dsh-antigravity-oauth: ${filename} account id must be a non-empty string`)
  }
  if (raw.addedAt !== undefined && typeof raw.addedAt !== 'string') {
    throw new Error(`dsh-antigravity-oauth: ${filename} account addedAt must be a string`)
  }
  return {
    ...grant,
    id: raw.id,
    ...typeof raw.addedAt === 'string' ? { addedAt: raw.addedAt } : {},
  }
}

type ParsedDocument = { document: AuthDocument, fromV1: boolean }

function parseDocument(text: string, filename: string): ParsedDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`dsh-antigravity-oauth: ${filename} is not valid JSON`)
  }
  if (!isRecord(value)) throw new Error(`dsh-antigravity-oauth: ${filename} must contain an object`)
  if (value.version === LEGACY_FORMAT_VERSION) {
    if (Object.keys(value).some(key => key !== 'version' && key !== 'credential')) {
      throw new Error(`dsh-antigravity-oauth: ${filename} contains an unknown top-level field`)
    }
    const credential = value.credential === undefined
      ? undefined
      : parseAntigravityOAuth(value.credential, filename)
    return {
      fromV1: true,
      document: {
        version: AUTH_FORMAT_VERSION,
        activeId: credential === undefined ? undefined : MIGRATED_ACCOUNT_ID,
        accounts: credential === undefined ? [] : [{ ...credential, id: MIGRATED_ACCOUNT_ID }],
      },
    }
  }
  if (value.version !== AUTH_FORMAT_VERSION) {
    throw new Error(`dsh-antigravity-oauth: ${filename} has unsupported auth format version ${String(value.version)}`)
  }
  if (Object.keys(value).some(key => key !== 'version' && key !== 'activeId' && key !== 'accounts')) {
    throw new Error(`dsh-antigravity-oauth: ${filename} contains an unknown top-level field`)
  }
  if (!Array.isArray(value.accounts)) {
    throw new Error(`dsh-antigravity-oauth: ${filename} accounts must be an array`)
  }
  if (value.accounts.length > MAX_ACCOUNTS) {
    throw new Error(`dsh-antigravity-oauth: ${filename} supports at most ${MAX_ACCOUNTS} accounts`)
  }
  const accounts = value.accounts.map(account => parseAccount(account, filename))
  const ids = new Set(accounts.map(account => account.id))
  if (ids.size !== accounts.length) {
    throw new Error(`dsh-antigravity-oauth: ${filename} contains duplicate account ids`)
  }
  let activeId: string | undefined
  if (value.activeId !== undefined) {
    if (typeof value.activeId !== 'string' || value.activeId.length === 0) {
      throw new Error(`dsh-antigravity-oauth: ${filename} activeId must be a non-empty string`)
    }
    if (!ids.has(value.activeId)) {
      throw new Error(`dsh-antigravity-oauth: ${filename} activeId does not reference a stored account`)
    }
    activeId = value.activeId
  } else if (accounts.length > 0) {
    activeId = accounts[0]!.id
  }
  return { fromV1: false, document: { version: AUTH_FORMAT_VERSION, activeId, accounts } }
}

export function antigravityAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), AUTH_FILENAME))
}

export class AntigravityCredentialStore {
  readonly filename: string

  constructor(filename: string = antigravityAuthPath()) {
    this.filename = resolve(filename)
  }

  private async readParsed(): Promise<ParsedDocument | undefined> {
    await assertOwnerOnly(this.filename)
    try {
      return parseDocument(await readFile(this.filename, 'utf8'), this.filename)
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  private async writeDocument(next: AuthDocument, fromV1: boolean): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    if (fromV1) {
      try {
        await copyFile(this.filename, this.filename + BACKUP_SUFFIX)
        await chmod(this.filename + BACKUP_SUFFIX, 0o600)
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
    }
    await writeFileAtomic(
      this.filename,
      `${JSON.stringify(next, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
  }

  async list(): Promise<StoredAccount[]> {
    const parsed = await this.readParsed()
    return parsed === undefined ? [] : parsed.document.accounts.map(account => structuredClone(account))
  }

  async active(): Promise<StoredAccount | undefined> {
    const parsed = await this.readParsed()
    if (parsed === undefined) return undefined
    const found = parsed.document.accounts.find(account => account.id === parsed.document.activeId)
      ?? parsed.document.accounts[0]
    return found === undefined ? undefined : structuredClone(found)
  }

  async get(id: string): Promise<StoredAccount | undefined> {
    const parsed = await this.readParsed()
    const found = parsed?.document.accounts.find(account => account.id === id)
    return found === undefined ? undefined : structuredClone(found)
  }

  async add(grant: AntigravityGrant): Promise<StoredAccount> {
    const clean = parseAntigravityOAuth(structuredClone(grant), this.filename)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const parsed = await this.readParsed()
      const accounts: StoredAccount[] = parsed === undefined
        ? []
        : parsed.document.accounts.map(account => structuredClone(account))
      const existing = accounts.find(account =>
        (clean.email !== undefined && account.email !== undefined && account.email === clean.email)
        || account.refresh === clean.refresh)
      let added: StoredAccount
      if (existing !== undefined) {
        const merged = {
          ...existing,
          ...clean,
          id: existing.id,
          ...existing.addedAt === undefined ? {} : { addedAt: existing.addedAt },
        }
        const index = accounts.indexOf(existing)
        accounts[index] = parseAccount(merged, this.filename)
        added = accounts[index]!
      } else {
        if (accounts.length >= MAX_ACCOUNTS) {
          throw new Error(`dsh-antigravity-oauth: at most ${MAX_ACCOUNTS} accounts are supported`)
        }
        added = parseAccount({
          ...structuredClone(clean),
          id: `acc_${randomUUID()}`,
          addedAt: new Date().toISOString(),
        }, this.filename)
        accounts.push(added)
      }
      await this.writeDocument({ version: AUTH_FORMAT_VERSION, activeId: added.id, accounts }, parsed?.fromV1 === true)
      return structuredClone(added)
    })
  }

  async update(id: string, patch: Partial<AntigravityGrant>): Promise<StoredAccount> {
    return withFileLock(this.filename, async () => {
      const parsed = await this.readParsed()
      if (parsed === undefined) throw new Error('dsh-antigravity-oauth: no accounts are stored')
      let updated: StoredAccount | undefined
      const accounts = parsed.document.accounts.map((account) => {
        if (account.id !== id) return account
        updated = parseAccount({ ...structuredClone(account), ...structuredClone(patch) }, this.filename)
        return updated
      })
      if (updated === undefined) throw new Error(`dsh-antigravity-oauth: unknown account ${id}`)
      await this.writeDocument({ version: AUTH_FORMAT_VERSION, activeId: parsed.document.activeId, accounts }, parsed.fromV1)
      return structuredClone(updated)
    })
  }

  async setActive(id: string): Promise<void> {
    await withFileLock(this.filename, async () => {
      const parsed = await this.readParsed()
      if (parsed === undefined) throw new Error('dsh-antigravity-oauth: no accounts are stored')
      if (!parsed.document.accounts.some(account => account.id === id)) {
        throw new Error(`dsh-antigravity-oauth: unknown account ${id}`)
      }
      await this.writeDocument({ ...parsed.document, activeId: id }, parsed.fromV1)
    })
  }

  async remove(id: string): Promise<StoredAccount> {
    return withFileLock(this.filename, async () => {
      const parsed = await this.readParsed()
      if (parsed === undefined) throw new Error('dsh-antigravity-oauth: no accounts are stored')
      const account = parsed.document.accounts.find(entry => entry.id === id)
      if (account === undefined) throw new Error(`dsh-antigravity-oauth: unknown account ${id}`)
      const accounts = parsed.document.accounts.filter(entry => entry.id !== id)
      const activeId = parsed.document.activeId === id ? accounts[0]?.id : parsed.document.activeId
      await this.writeDocument({ version: AUTH_FORMAT_VERSION, activeId, accounts }, parsed.fromV1)
      return structuredClone(account)
    })
  }
}
