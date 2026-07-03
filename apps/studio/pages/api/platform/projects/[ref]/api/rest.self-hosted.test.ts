import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => {
  const original = await importOriginal<object>()
  return {
    ...original,
    resolveProjectConnection,
  }
})

afterEach(() => vi.unstubAllGlobals())

describe('GET /platform/projects/{ref}/api/rest (plain self-hosted, zero-break)', () => {
  it('proxies to global SUPABASE_URL with global service key; resolver never called', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('SUPABASE_URL', 'http://localhost:8000')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-key')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ paths: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./rest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/rest/v1/')
    expect(fetchMock.mock.calls[0][1].headers.apikey).toBe('global-service-key')
    expect(res._getStatusCode()).toBe(200)
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
