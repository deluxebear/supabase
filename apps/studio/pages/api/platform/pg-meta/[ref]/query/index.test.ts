// [self-platform] Deferred finding 8 — this route's ProjectNotFound -> 404
// mapping was untested. Self-platform on + an unknown ref must map to
// `404 {message:'Project not found'}`, consistent with Task 6/7's
// resolveProjectConnection error handling used by the sibling routes.
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { checkPermissionWithContext } from '@/lib/api/self-platform/rbac/enforce'
import {
  resolveProjectConnection,
  resolveProjectIdentity,
} from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn(), resolveProjectIdentity: vi.fn() }
})
// [self-platform] Task 12: the route now gates on tenant:Sql:Query before
// executeQuery. These pre-existing tests aren't exercising the readOnly
// matrix (see index.rbac.test.ts for that) — default to an Owner-shaped
// context so `can` is true and readOnly resolves false, preserving this
// suite's original (pre-guard) behavior.
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermissionWithContext: vi.fn() }))

const OWNER_CTX = {
  gotrueId: 'g-1',
  roles: [
    {
      id: 1,
      baseRoleId: 1,
      baseRoleName: 'Owner',
      name: 'Owner',
      orgId: 1,
      orgSlug: 'default',
      projectRefs: [],
      projectIds: [],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkPermissionWithContext).mockResolvedValue({ can: true, ctx: OWNER_CTX })
})

describe('POST /platform/pg-meta/[ref]/query (self-platform)', () => {
  it('returns 404 Project not found when identity resolution throws ProjectNotFound', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    vi.mocked(resolveProjectIdentity).mockRejectedValue(new ProjectNotFound('ghost'))

    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'ghost' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
    // [self-platform] Task 12: 404-before-403 — the permission check never
    // runs when the ref doesn't resolve.
    expect(checkPermissionWithContext).not.toHaveBeenCalled()
  })

  it('executes against the resolved project connection when the project is registered', async () => {
    vi.mocked(resolveProjectIdentity).mockResolvedValue({ ref: 'proj-b' } as never)
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      supabaseUrl: 'http://project-b.example',
      serviceKey: 'PROJECT_SERVICE_KEY',
      pgConnEncrypted: 'ENC-B',
      pgConnReadOnlyEncrypted: 'ENC-B-RO',
    } as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ok: true }]), { status: 200 }))
    )

    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const [url, init] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toBe('http://project-b.example/pg/query')
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe('ENC-B')

    vi.unstubAllGlobals()
  })
})
