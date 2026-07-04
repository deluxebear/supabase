import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./signup')).handler
}
afterEach(() => vi.unstubAllEnvs())

describe('signup — self-platform invite-only', () => {
  it('POST returns 403 invite-only WITHOUT calling GoTrue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = await loadHandler('true')
    const { req, res } = createMocks({ method: 'POST', body: { email: 'a@x.test', password: 'p' } })
    await handler(req as never, res as never)
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData().message).toContain('invite-only')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
