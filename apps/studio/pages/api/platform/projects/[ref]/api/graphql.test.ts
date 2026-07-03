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

describe('POST /platform/projects/{ref}/api/graphql (self-platform)', () => {
  it('proxies the resolved project GraphQL url with its service key', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
      anonKey: 'anon-b',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][0]).toBe('http://kong-b:8100/graphql/v1')
    expect(fetchMock.mock.calls[0][1].headers.apikey).toBe('service-b')
    expect(res._getStatusCode()).toBe(200)
    vi.unstubAllGlobals()
  })

  it('uses anonKey as Authorization fallback when x-graphql-authorization is not provided', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
      anonKey: 'anon-b',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer anon-b')
    vi.unstubAllGlobals()
  })

  it('passes through x-graphql-authorization header if provided', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
      anonKey: 'anon-b',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      headers: { 'x-graphql-authorization': 'Bearer custom-token' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer custom-token')
    vi.unstubAllGlobals()
  })

  it('unregistered default (row null) falls through to global env url/key', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://kong-global:8100')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-key')
    // A successful resolve with no registered row (the unregistered-default
    // case). The `if (conn.row)` guard must fall through to the global env
    // target — conn.supabaseUrl/serviceKey/anonKey must NOT be used.
    resolveProjectConnection.mockResolvedValueOnce({
      row: null,
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'sk',
      anonKey: 'ak',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'default' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][0]).toBe('http://kong-global:8100/graphql/v1')
    expect(fetchMock.mock.calls[0][1].headers.apikey).toBe('global-service-key')
    expect(res._getStatusCode()).toBe(200)
    vi.unstubAllGlobals()
  })

  it('404s unknown ref before fetching', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'ghost' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
