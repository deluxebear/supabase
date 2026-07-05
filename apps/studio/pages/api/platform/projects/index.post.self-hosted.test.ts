import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', 'true')
  return (await import('./index')).handler
}
afterEach(() => vi.unstubAllEnvs())

describe('POST /platform/projects zero-break (plain self-hosted)', () => {
  it('POST → 404 house message', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'POST', body: { mode: 'shared-db' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })

  it('GET keeps the legacy single-project array', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(Array.isArray(res._getJSONData())).toBe(true)
  })

  it('405 Allow header stays GET-only in plain mode', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'PUT' })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(405)
    expect(res._getHeaders().allow).toEqual(['GET'])
  })
})
