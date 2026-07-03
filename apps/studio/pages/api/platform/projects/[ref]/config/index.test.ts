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
afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/projects/{ref}/config (self-platform)', () => {
  it('returns the resolved project jwt_secret, keeping non-secret fields', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.jwt_secret).toBe('secret-b')
    expect(body.db_anon_role).toBe('anon')
    expect(body.db_schema).toBe('public, storage')
    expect(body.max_rows).toBe(100)
  })

  it('unregistered default (row null) falls through to env jwt_secret, not conn.jwtSecret', async () => {
    vi.stubEnv('AUTH_JWT_SECRET', 'env-default-secret')
    // A successful resolve with no registered row (the unregistered-default
    // case). The `if (conn.row)` guard must fall through to the env default —
    // conn.jwtSecret ('') must NOT be used.
    resolveProjectConnection.mockResolvedValueOnce({ row: null, jwtSecret: '' })
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().jwt_secret).toBe('env-default-secret')
  })

  it('404s unknown ref', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('403s when checkPermission denies secrets:Read, without leaking jwt_secret', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    vi.mocked(checkPermission).mockResolvedValueOnce(false)
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-3'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(res._getJSONData()).not.toHaveProperty('jwt_secret')
  })

  it('calls checkPermission with the exact secrets:Read declaration', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    const { handler } = await import('./index')
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
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(checkPermission).not.toHaveBeenCalled()
  })
})
