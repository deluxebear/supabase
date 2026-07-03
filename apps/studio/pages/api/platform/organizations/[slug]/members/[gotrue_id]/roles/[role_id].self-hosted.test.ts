import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./[role_id]')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('member role route — plain self-hosted (zero-break)', () => {
  it('returns the full 404 body unchanged', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({
      method: 'PUT',
      query: { slug: 'default', gotrue_id: 'g-t', role_id: '7' },
    })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
