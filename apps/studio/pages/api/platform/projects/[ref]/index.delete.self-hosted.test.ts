import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', 'true')
  return (await import('./index')).handler
}
afterEach(() => vi.unstubAllEnvs())

describe('DELETE [ref] zero-break (plain self-hosted)', () => {
  it('DELETE → 404 house message', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'DELETE', query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })

  it('GET keeps the historical stub byte-identically', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({ connectionString: '' })
  })

  it('405 Allow header stays GET-only in plain mode', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'PUT', query: { ref: 'x' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(405)
    expect(res._getHeaders().allow).toEqual(['GET'])
  })
})
