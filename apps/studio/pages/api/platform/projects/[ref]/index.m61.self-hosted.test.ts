import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', 'true')
  return (await import('./index')).handler
}
afterEach(() => vi.unstubAllEnvs())

describe('PATCH [ref] zero-break (plain self-hosted)', () => {
  it('PATCH → 404 house message', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'default' },
      body: { name: 'x' },
    })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })

  it('GET keeps the historical stub with no self_platform block', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().self_platform).toBeUndefined()
  })

  it('405 Allow header stays GET-only in plain mode', async () => {
    const handler = await loadHandler()
    const { req, res } = createMocks({ method: 'PUT', query: { ref: 'x' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(405)
    expect(res._getHeaders().allow).toEqual(['GET'])
  })
})
