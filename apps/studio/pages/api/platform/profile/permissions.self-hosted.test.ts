import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./permissions')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('permissions route — plain self-hosted (zero-break)', () => {
  it('returns the full 404 body unchanged', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req, res, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
