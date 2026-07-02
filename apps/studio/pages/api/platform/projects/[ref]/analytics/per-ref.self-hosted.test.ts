// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). per-ref.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so this
// sibling covers the off-branch with a fresh module load per Task 6's
// pattern (see auth/[ref]/per-ref.self-hosted.test.ts).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getAnalyticsTarget = vi.fn()
const retrieveAnalyticsData = vi.fn()
vi.mock('@/lib/api/self-hosted/logs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAnalyticsTarget,
  retrieveAnalyticsData,
}))

const ROUTES: Array<[string, string, Record<string, string>]> = [
  ['./endpoints/[name]', 'GET', { name: 'logs.all' }],
  ['./log-drains', 'GET', {}],
  ['./log-drains/[uuid]', 'GET', { uuid: 'u-1' }],
]

afterEach(() => {
  vi.unstubAllEnvs()
  getAnalyticsTarget.mockReset()
  retrieveAnalyticsData.mockReset()
})

describe.each(ROUTES)('analytics zero-break: %s', (path, method, extraQuery) => {
  it('plain self-hosted never touches getAnalyticsTarget', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    retrieveAnalyticsData.mockResolvedValue({ data: {}, error: undefined })
    const { handler } = await import(path)
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'default', ...extraQuery },
    })
    await handler(req as any, res as any)
    expect(getAnalyticsTarget).not.toHaveBeenCalled()
  })
})

describe('log-drains plain self-hosted (byte-exact env-check message)', () => {
  it('GET 500s with the exact env-vars-not-set message when LOGFLARE env vars are unset', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('LOGFLARE_PRIVATE_ACCESS_TOKEN', '')
    vi.stubEnv('LOGFLARE_URL', '')
    const { handler } = await import('./log-drains')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(getAnalyticsTarget).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(500)
    expect(res._getJSONData()).toEqual({
      error: {
        message: 'LOGFLARE_PRIVATE_ACCESS_TOKEN, LOGFLARE_URL env variables are not set',
      },
    })
  })
})
