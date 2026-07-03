import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from '../../../../../../../pages/api/v1/projects/[ref]/api-keys/[id]'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'

// [self-platform] CRITICAL 2 — the by-id reveal route must resolve the
// per-ref connection like the sibling list route (api-keys.ts / Task 7),
// not silently serve global-env keys for a resolved project.
//
// NB: deliberately kept in the `tests/` mirror tree, NOT colocated as
// `pages/api/v1/projects/[ref]/api-keys/[id].self-platform.test.ts` —
// Next's Turbopack dev/build router treats any `[id].*.ts` sibling of the
// `[id].ts` dynamic-segment route file as part of the same route's module
// graph, which broke `next dev` for the real route (`Vitest mocker was not
// initialized in this environment` on every request) when this was tried
// colocated. The sibling list route (`api-keys.ts`, not a bracketed
// filename) doesn't have this hazard, hence its self-hosted sibling test IS
// colocated (see `api-keys.self-hosted.test.ts`).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn() }
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermission: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const resolved = {
  ref: 'proj-b',
  anonKey: 'ANON-B',
  serviceKey: 'PROJECT-SERVICE-B',
  publishableKey: null,
  secretKey: 'sb_secret_b_abcdefghijklmnop',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(checkPermission).mockResolvedValue(true)
})

describe('GET /v1/projects/[ref]/api-keys/[id] (self-platform)', () => {
  it('by-id reveal returns the RESOLVED project key, not the global env key', async () => {
    // Global env stubbed to a distinct value to prove it is NOT returned.
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-should-not-leak')
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', id: 'service_role', reveal: 'true' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.api_key).toBe('PROJECT-SERVICE-B')
    expect(body.api_key).not.toBe('global-service-should-not-leak')
    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
  })

  it('masks the resolved secret key when reveal is not true', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', id: 'secret' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.api_key).toBe('sb_secret_b_abc')
  })

  it('returns 404 when the resolved project has no matching key id', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', id: 'missing' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(404)
  })

  it('returns 404 Project not found for an unknown ref', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    vi.mocked(resolveProjectConnection).mockRejectedValue(new ProjectNotFound('ghost'))

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'ghost', id: 'service_role' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('403s when checkPermission denies secrets:Read, without leaking the key', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)
    vi.mocked(checkPermission).mockResolvedValueOnce(false)

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', id: 'service_role', reveal: 'true' },
    })
    await handler(req as any, res as any, claimsOf('g-3'))

    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(JSON.stringify(res._getJSONData())).not.toContain('PROJECT-SERVICE-B')
  })

  it('calls checkPermission with the exact secrets:Read declaration', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', id: 'service_role' },
    })
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
    vi.mocked(resolveProjectConnection).mockRejectedValue(new ProjectNotFound('ghost'))

    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'ghost', id: 'service_role' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(res._getStatusCode()).toBe(404)
    expect(checkPermission).not.toHaveBeenCalled()
  })
})
