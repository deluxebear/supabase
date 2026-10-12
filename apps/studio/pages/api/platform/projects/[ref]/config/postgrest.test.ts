import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkPermission, guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  mergeStoredServiceConfig,
  readStoredServiceConfig,
} from '@/lib/api/self-platform/service-settings'

const resolveProjectConnection = vi.fn()

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
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

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  checkPermission: vi.fn(),
  guardProjectRoute: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/service-settings', () => ({
  readStoredServiceConfig: vi.fn(),
  mergeStoredServiceConfig: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  resolveProjectConnection.mockReset()
  vi.mocked(checkPermission).mockReset()
  vi.mocked(checkPermission).mockResolvedValue(true)
  vi.mocked(guardProjectRoute).mockReset()
  vi.mocked(guardProjectRoute).mockResolvedValue(true)
  vi.mocked(readStoredServiceConfig).mockReset()
  vi.mocked(readStoredServiceConfig).mockResolvedValue({})
  vi.mocked(mergeStoredServiceConfig).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/projects/{ref}/config/postgrest (self-platform)', () => {
  it('returns the resolved project jwt_secret, keeping PGRST fields', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.jwt_secret).toBe('secret-b')
    expect(body.db_anon_role).toBe('anon')
    expect(body.db_schema).toBe('public,storage,graphql_public')
    expect(body.max_rows).toBe(1000)
  })

  it('unregistered default (row null) falls through to env jwt_secret, not conn.jwtSecret', async () => {
    vi.stubEnv('AUTH_JWT_SECRET', 'env-default-secret')
    // A successful resolve with no registered row (the unregistered-default
    // case). The `if (conn.row)` guard must fall through to the env default —
    // conn.jwtSecret ('') must NOT be used.
    resolveProjectConnection.mockResolvedValueOnce({ row: null, jwtSecret: '' })
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().jwt_secret).toBe('env-default-secret')
  })

  it('404s unknown ref', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('403s when checkPermission denies secrets:Read, without leaking jwt_secret', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    vi.mocked(checkPermission).mockResolvedValueOnce(false)
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-3'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(res._getJSONData()).not.toHaveProperty('jwt_secret')
  })

  it('calls checkPermission with the exact secrets:Read declaration', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    expect(checkPermission).toHaveBeenCalledWith(
      claimsOf('g-1'),
      expect.objectContaining({
        action: PermissionAction.SECRETS_READ,
        resource: 'projects',
        projectRef: 'proj-b',
      })
    )
  })

  it('404s before checkPermission is invoked for an unknown ref', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(checkPermission).not.toHaveBeenCalled()
  })
})

describe('stored settings (fleet)', () => {
  it('GET shows stored overrides over the stack defaults', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    vi.mocked(readStoredServiceConfig).mockResolvedValueOnce({
      max_rows: 250,
      db_schema: 'public,api',
    })
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    const body = res._getJSONData()
    expect(body.max_rows).toBe(250)
    expect(body.db_schema).toBe('public,api')
    expect(body.db_extra_search_path).toBe('public')
  })

  it('PATCH stores validated settings as desired state', async () => {
    vi.mocked(mergeStoredServiceConfig).mockResolvedValueOnce({ max_rows: 250 })
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'proj-b' },
      body: { max_rows: 250, db_pool: null },
    })
    await handler(req as any, res as any, claimsOf('user-1'))
    expect(res._getStatusCode()).toBe(200)
    expect(guardProjectRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: PermissionAction.UPDATE,
        resource: 'custom_config_postgrest',
        projectRef: 'proj-b',
      })
    )
    expect(mergeStoredServiceConfig).toHaveBeenCalledWith({
      projectRef: 'proj-b',
      service: 'postgrest',
      patch: { max_rows: 250, db_pool: null },
      actor: 'user-1',
    })
  })

  it('PATCH rejects invalid settings without storing', async () => {
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'proj-b' },
      body: { db_schema: 'public;drop' },
    })
    await handler(req as any, res as any, claimsOf('user-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(mergeStoredServiceConfig).not.toHaveBeenCalled()
  })

  it('PATCH stops when the permission check denies', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValueOnce(false)
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'proj-b' },
      body: { max_rows: 10 },
    })
    await handler(req as any, res as any, claimsOf('user-1'))
    expect(mergeStoredServiceConfig).not.toHaveBeenCalled()
  })
})
