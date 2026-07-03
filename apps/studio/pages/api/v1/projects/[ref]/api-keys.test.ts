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

describe('GET /v1/projects/{ref}/api-keys (self-platform)', () => {
  it('returns the resolved project keys', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      anonKey: 'anon-b',
      serviceKey: 'service-b',
      publishableKey: null,
      secretKey: null,
    })
    const { handler } = await import('./api-keys')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ id: 'anon', api_key: 'anon-b' })
    expect(body[1]).toMatchObject({ id: 'service_role', api_key: 'service-b' })
  })

  it('404s unknown ref', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./api-keys')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('403s when checkPermission denies secrets:Read, without leaking keys', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      anonKey: 'anon-b',
      serviceKey: 'service-b',
      publishableKey: null,
      secretKey: null,
    })
    vi.mocked(checkPermission).mockResolvedValueOnce(false)
    const { handler } = await import('./api-keys')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-3'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(JSON.stringify(res._getJSONData())).not.toContain('anon-b')
  })

  it('calls checkPermission with the exact secrets:Read declaration', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      anonKey: 'anon-b',
      serviceKey: 'service-b',
      publishableKey: null,
      secretKey: null,
    })
    const { handler } = await import('./api-keys')
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
    const { handler } = await import('./api-keys')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(checkPermission).not.toHaveBeenCalled()
  })
})
