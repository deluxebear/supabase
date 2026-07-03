// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off): the endpoints/[name] param validation added for self-platform (array
// ref/name -> 400) must NOT leak into the plain branch, which keeps the
// original `assert(...)` calls byte-identically (array ref/name -> thrown
// AssertionError -> apiWrapper 500 `{ error }`).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const retrieveAnalyticsData = vi.fn()
vi.mock('@/lib/api/self-hosted/logs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveAnalyticsData,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  retrieveAnalyticsData.mockReset()
})

describe('endpoints/[name] plain self-hosted (byte-exact assert path)', () => {
  it('array ref still throws the original AssertionError (500 { error }), not a 400', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    // Use the default export (apiWrapper-wrapped) — the bare `assert()` throw
    // happens before the route's own try/catch, so only apiWrapper's
    // catch-all maps it to a response.
    const route = (
      await import('../../../../../../../../pages/api/platform/projects/[ref]/analytics/endpoints/[name]')
    ).default
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: ['a', 'b'], name: 'logs.all' },
    })
    await route(req as any, res as any)
    expect(retrieveAnalyticsData).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(500)
    const body = res._getJSONData()
    expect(body.message).toBeUndefined()
    expect(body.error).toMatchObject({ code: 'ERR_ASSERTION', generatedMessage: false })
  })

  it('missing name still throws the original AssertionError (500 { error }), not a 400', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    const route = (
      await import('../../../../../../../../pages/api/platform/projects/[ref]/analytics/endpoints/[name]')
    ).default
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b' },
    })
    await route(req as any, res as any)
    expect(retrieveAnalyticsData).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(500)
    const body = res._getJSONData()
    expect(body.message).toBeUndefined()
    expect(body.error).toMatchObject({ code: 'ERR_ASSERTION', generatedMessage: false })
  })
})
