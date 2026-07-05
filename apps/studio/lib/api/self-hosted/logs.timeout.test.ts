import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadModule() {
  vi.resetModules()
  // [self-platform] mechanical fix (not a semantic change): plain
  // self-hosted is IS_PLATFORM=false + IS_SELF_PLATFORM=false — that's the
  // only combo assertSelfHosted() allows through to the LOGFLARE_URL/
  // LOGFLARE_PRIVATE_ACCESS_TOKEN env-fallback branch this test exercises.
  // (IS_PLATFORM=true + IS_SELF_PLATFORM=false is the cloud combo, which
  // assertSelfHosted() correctly rejects — that combo cannot reach fetch.)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', '')
  vi.stubEnv('LOGFLARE_URL', 'http://lf:4000')
  vi.stubEnv('LOGFLARE_PRIVATE_ACCESS_TOKEN', 'tok')
  return await import('./logs')
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('retrieveAnalyticsData timeout (M6.2 D6)', () => {
  it('fetch carries an AbortSignal; an abort resolves to the error shape (no throw)', async () => {
    const mod = await loadModule()
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      )
    vi.stubGlobal('fetch', fetchMock)
    const { data, error } = await mod.retrieveAnalyticsData({
      name: 'logs.all',
      projectRef: 'default',
      params: {},
    })
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(data).toBeUndefined()
    expect(error?.message).toMatch(/abort/i)
    expect(mod.ANALYTICS_TIMEOUT_MS).toBe(15_000)
  })
})
