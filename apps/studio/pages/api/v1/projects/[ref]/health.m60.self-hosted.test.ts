import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', 'true')
  return (await import('./health')).handler
}
afterEach(() => vi.unstubAllEnvs())

describe('v1 health zero-break (plain self-hosted)', () => {
  it('static all-healthy stub, byte-identical to M1', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'default', services: 'auth,db' },
    })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([
      { name: 'auth', healthy: true, status: 'ACTIVE_HEALTHY' },
      { name: 'db', healthy: true, status: 'ACTIVE_HEALTHY' },
    ])
  })
})
