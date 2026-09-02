import { afterEach, describe, expect, it } from 'vitest'
import { proxyUrlFor } from '../src/proxy-fetch.ts'

const KEYS = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
] as const

const saved: Record<string, string | undefined> = {}

function stash(): void {
  for (const key of KEYS) saved[key] = process.env[key]
}

function restore(): void {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function clear(): void {
  for (const key of KEYS) delete process.env[key]
}

afterEach(() => {
  restore()
})

describe('proxyUrlFor', () => {
  it('uses HTTPS_PROXY for google CCA and skips localhost', () => {
    stash()
    clear()
    process.env.HTTPS_PROXY = 'http://127.0.0.1:45678'
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    expect(proxyUrlFor('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent')).toBe('http://127.0.0.1:45678')
    expect(proxyUrlFor('http://127.0.0.1:43127/')).toBeUndefined()
  })
})
