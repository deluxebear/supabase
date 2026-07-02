import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

async function loadModule(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', selfPlatform)
  return await import('./logs')
}

afterEach(() => {
  vi.unstubAllEnvs()
  resolveProjectConnection.mockReset()
})

describe('getAnalyticsTarget', () => {
  it('registry hit with analytics configured: per-ref target, project param "default"', async () => {
    const mod = await loadModule('true')
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      ref: 'proj-b',
      logflareUrl: 'http://lf-b:4000/',
      logflareToken: 'tok-b',
    })
    const target = await mod.getAnalyticsTarget('proj-b')
    expect(target).toEqual({ baseUrl: 'http://lf-b:4000', token: 'tok-b', projectParam: 'default' })
  })

  it('registry hit with NULL analytics: throws AnalyticsNotConfigured, no env fallback', async () => {
    vi.stubEnv('LOGFLARE_URL', 'http://global-lf')
    vi.stubEnv('LOGFLARE_PRIVATE_ACCESS_TOKEN', 'global-tok')
    const mod = await loadModule('true')
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      ref: 'proj-b',
      logflareUrl: null,
      logflareToken: null,
    })
    await expect(mod.getAnalyticsTarget('proj-b')).rejects.toBeInstanceOf(
      mod.AnalyticsNotConfigured
    )
  })

  it('unregistered default falls back to global env with ref as project param', async () => {
    vi.stubEnv('LOGFLARE_URL', 'http://global-lf')
    vi.stubEnv('LOGFLARE_PRIVATE_ACCESS_TOKEN', 'global-tok')
    const mod = await loadModule('true')
    resolveProjectConnection.mockResolvedValueOnce({ row: null, ref: 'default' })
    const target = await mod.getAnalyticsTarget('default')
    expect(target).toEqual({
      baseUrl: 'http://global-lf',
      token: 'global-tok',
      projectParam: 'default',
    })
  })
})
