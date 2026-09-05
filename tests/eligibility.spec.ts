import { describe, expect, it } from 'vitest'
import { discoverProject } from '../src/oauth.ts'

const region = 'Your current account is not eligible for Antigravity, because it is not currently available in your location.'
function responder(payloads: unknown[]) {
  const calls: { url: string, body: any }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
    const payload = payloads.shift()
    if (payload === undefined) throw new Error('Unexpected extra request')
    return Response.json(payload)
  }
  return { calls, fetcher }
}

describe('Antigravity entitlement discovery', () => {
  it('uses an existing paid project even when the free tier is ineligible', async () => {
    const { fetcher, calls } = responder([{
      currentTier: { id: 'paid-tier' }, cloudaicompanionProject: 'existing-project',
      ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: region }],
    }])
    expect(await discoverProject('fixture-token', fetcher)).toBe('existing-project')
    expect(calls).toHaveLength(1)
  })
  it('accepts an object-form project from an existing paid tier', async () => {
    const { fetcher } = responder([{
      paidTier: { id: 'pro' }, cloudaicompanionProject: { id: 'paid-project' },
    }])
    expect(await discoverProject('fixture-token', fetcher)).toBe('paid-project')
  })
  it('onboards only into a server-advertised default tier', async () => {
    const { fetcher, calls } = responder([
      { allowedTiers: [{ id: 'server-tier', isDefault: true }] },
      { done: true, response: {} },
      { currentTier: { id: 'server-tier' }, cloudaicompanionProject: 'new-project' },
    ])
    expect(await discoverProject('fixture-token', fetcher)).toBe('new-project')
    expect(calls[1].body.tierId).toBe('server-tier')
  })
  it('keeps a real eligibility rejection and never attempts onboarding', async () => {
    const { fetcher, calls } = responder([{
      ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: region }],
    }])
    await expect(discoverProject('fixture-token', fetcher)).rejects.toThrow(region)
    expect(calls).toHaveLength(1)
  })
})
