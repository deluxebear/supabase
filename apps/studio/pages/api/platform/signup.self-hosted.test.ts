// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). signup.test.ts loads the handler with NEXT_PUBLIC_SELF_PLATFORM=true,
// so this sibling covers the off-branch with a fresh module load per the
// loadHandler pattern (see projects/index.self-hosted.test.ts).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./signup')).handler
}
afterEach(() => vi.unstubAllEnvs())

describe('POST /platform/signup (plain self-hosted, zero-break)', () => {
  it('returns the 404 body unchanged when self-platform is off, without calling GoTrue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = await loadHandler('')
    const { req, res } = createMocks({
      method: 'POST',
      body: { email: 'a@x.test', password: 'p' },
    })
    await handler(req as never, res as never)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Signup is not available on this deployment' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
