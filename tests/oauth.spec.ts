import { describe, expect, it } from 'vitest'
import { CALLBACK_URI, CLIENT_ID, extractOAuthCode, authorizationUrl, SCOPES } from '../src/oauth.ts'

describe('oauth helpers', () => {
  it('builds a desktop authorization URL for the registered callback', () => {
    const url = new URL(authorizationUrl('st'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URI)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('select_account consent')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...SCOPES])
  })

  it('extracts a code from a pasted redirect URL', () => {
    expect(extractOAuthCode('http://127.0.0.1:51121/oauth-callback?code=abc&state=st')).toEqual({
      code: 'abc',
      state: 'st',
    })
    expect(extractOAuthCode('abc')).toEqual({ code: 'abc' })
  })
})
