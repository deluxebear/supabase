import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./invitations')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('invitations route — plain self-hosted (zero-break)', () => {
  it('GET returns the full 404 body unchanged', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })

  it('POST returns the full 404 body unchanged (no create in plain mode)', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { emails: ['a@x.test'], role_id: 3 },
    })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
