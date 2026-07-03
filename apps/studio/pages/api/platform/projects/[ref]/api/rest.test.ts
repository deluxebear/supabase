import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => {
  const original = await importOriginal<object>()
  return {
    ...original,
    resolveProjectConnection,
  }
})

beforeEach(() => resolveProjectConnection.mockReset())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('GET /platform/projects/{ref}/api/rest (self-platform)', () => {
  it('proxies the resolved project REST url with its service key', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ paths: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./rest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][0]).toBe('http://kong-b:8100/rest/v1/')
    expect(fetchMock.mock.calls[0][1].headers.apikey).toBe('service-b')
    expect(res._getStatusCode()).toBe(200)
    vi.unstubAllGlobals()
  })

  it('unregistered default (row null) falls through to global env url/key', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://kong-global:8100')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-key')
    // A successful resolve with no registered row (the unregistered-default
    // case). The `if (conn.row)` guard must fall through to the global env
    // target — conn.supabaseUrl/serviceKey must NOT be used.
    resolveProjectConnection.mockResolvedValueOnce({
      row: null,
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'sk',
      anonKey: 'ak',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ paths: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./rest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][0]).toBe('http://kong-global:8100/rest/v1/')
    expect(fetchMock.mock.calls[0][1].headers.apikey).toBe('global-service-key')
    expect(res._getStatusCode()).toBe(200)
    vi.unstubAllGlobals()
  })

  it('404s unknown ref before fetching', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./rest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
