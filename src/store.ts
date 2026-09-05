import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { AUTH_FILENAME } from './ids.ts'
import type { AntigravityGrant } from './types.ts'
import { isRecord } from './types.ts'

const AUTH_FORMAT_VERSION = 1
const OAUTH_FIELDS = new Set(['type', 'access', 'refresh', 'expires', 'projectId', 'email'])

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  credential: AntigravityGrant
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

function parseDocument(text: string, filename: string): AuthDocument | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`dsh-antigravity-oauth: ${filename} is not valid JSON`)
  }
  if (!isRecord(value)) throw new Error(`dsh-antigravity-oauth: ${filename} must contain an object`)
  if (value.version !== AUTH_FORMAT_VERSION) {
    throw new Error(`dsh-antigravity-oauth: ${filename} has unsupported auth format version ${String(value.version)}`)
  }
  if (Object.keys(value).some(key => key !== 'version' && key !== 'credential')) {
    throw new Error(`dsh-antigravity-oauth: ${filename} contains an unknown top-level field`)
  }
  if (value.credential === undefined) return undefined
  return { version: AUTH_FORMAT_VERSION, credential: parseAntigravityOAuth(value.credential, filename) }
}

export function antigravityAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), AUTH_FILENAME))
}

export class AntigravityCredentialStore {
  readonly filename: string

  constructor(filename: string = antigravityAuthPath()) {
    this.filename = resolve(filename)
  }

  private async readDocument(): Promise<AuthDocument | undefined> {
    await assertOwnerOnly(this.filename)
    try {
      return parseDocument(await readFile(this.filename, 'utf8'), this.filename)
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  async read(): Promise<AntigravityGrant | undefined> {
    const document = await this.readDocument()
    return document === undefined ? undefined : structuredClone(document.credential)
  }

  async write(credential: AntigravityGrant): Promise<AntigravityGrant> {
    const next = parseAntigravityOAuth(credential, this.filename)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      await writeFileAtomic(
        this.filename,
        `${JSON.stringify({ version: AUTH_FORMAT_VERSION, credential: next }, null, 2)}\n`,
        { mode: 0o600, dirMode: 0o700 },
      )
      return structuredClone(next)
    })
  }

  async modify(
    fn: (current: AntigravityGrant | undefined) => Promise<AntigravityGrant | undefined>,
  ): Promise<AntigravityGrant | undefined> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const current = (await this.readDocument())?.credential
      const candidate = await fn(current === undefined ? undefined : structuredClone(current))
      if (candidate === undefined) return current === undefined ? undefined : structuredClone(current)
      const next = parseAntigravityOAuth(candidate, this.filename)
      await writeFileAtomic(
        this.filename,
        `${JSON.stringify({ version: AUTH_FORMAT_VERSION, credential: next }, null, 2)}\n`,
        { mode: 0o600, dirMode: 0o700 },
      )
      return structuredClone(next)
    })
  }

  async clear(): Promise<void> {
    await rm(this.filename, { force: true })
  }
}
