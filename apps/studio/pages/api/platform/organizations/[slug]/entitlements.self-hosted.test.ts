import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./entitlements')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('entitlements route — plain self-hosted (zero-break)', () => {
  it('keeps the M1 empty stub byte-identical', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ entitlements: [] })
  })
})
