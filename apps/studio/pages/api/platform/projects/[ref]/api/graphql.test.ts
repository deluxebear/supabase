import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'

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

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermission: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  resolveProjectConnection.mockReset()
  vi.mocked(checkPermission).mockReset()
  vi.mocked(checkPermission).mockResolvedValue(true)
})
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
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(checkPermission).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('403s when checkPermission denies tenant:Sql:Admin:Write, without fetching', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
      anonKey: 'anon-b',
    })
    vi.mocked(checkPermission).mockResolvedValueOnce(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any, claimsOf('g-3'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('unregistered default (row null) also requires tenant:Sql:Admin:Write; denies with no fetch', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://kong-global:8100')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-key')
    resolveProjectConnection.mockResolvedValueOnce({
      row: null,
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'sk',
      anonKey: 'ak',
    })
    vi.mocked(checkPermission).mockResolvedValueOnce(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./graphql')
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'default' },
      body: { query: 'query {}' },
    })
    await handler(req as any, res as any, claimsOf('g-3'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('calls checkPermission with the exact tenant:Sql:Admin:Write declaration', async () => {
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
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    expect(checkPermission).toHaveBeenCalledWith(
      claimsOf('g-1'),
      expect.objectContaining({
        action: PermissionAction.TENANT_SQL_ADMIN_WRITE,
        resource: 'tables',
        projectRef: 'proj-b',
      })
    )
    vi.unstubAllGlobals()
  })

  it('dead-code fold: Authorization fallback uses conn.anonKey directly, no `?? undefined` indirection', async () => {
    // Pins the M2.2-deferred fold (`anonKey = conn.anonKey ?? undefined` ->
    // `anonKey = conn.anonKey`): conn.anonKey is typed `string`, so the
    // resolved-row branch must flow it straight into the Authorization
    // fallback with no behavioral difference.
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
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer anon-b')
    vi.unstubAllGlobals()
  })
})
