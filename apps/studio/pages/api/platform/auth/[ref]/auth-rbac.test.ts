// [self-platform] Task 13: table-driven RBAC guard coverage for the 7
// auth-admin [ref] routes: the four "link" routes (invite/magiclink/otp/
// recover), which resolve their GoTrue target via resolveProjectConnection +
// fetchPost, and the three "users" routes, which use the per-ref admin
// client factory. Mirrors pg-meta/[ref]/rbac-guards.test.ts's shape.
//
// guardProjectRoute is fully mocked here — allow/deny plumbing is what this
// suite pins, not permission-matrix semantics (that's Task 4's matrix
// tests). For the users family, "factory not called on deny" means
// getAdminClientForRef (mocked via @/lib/api/self-hosted-admin). The link
// family doesn't call that factory at all — its resolve-first analog is
// fetchPost (mocked via @/data/fetchers), so deny is asserted against that
// instead.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const getAdminClientForRef = vi.fn()
const getAdminContextForRef = vi.fn()
vi.mock('@/lib/api/self-hosted-admin', () => ({
  selfHostedSupabaseAdmin: {},
  getAdminClientForRef,
  getAdminContextForRef,
}))

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

const fetchPost = vi.fn()
vi.mock('@/data/fetchers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPost,
}))

const makeAuthAdminClient = () => ({
  auth: {
    admin: {
      createUser: vi.fn().mockResolvedValue({ data: { user: {} }, error: null }),
      updateUserById: vi.fn().mockResolvedValue({ data: { user: {} }, error: null }),
      deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { factors: [] }, error: null }),
        deleteFactor: vi.fn().mockResolvedValue({ error: null }),
      },
    },
  },
})

const USER_ROUTES: Array<
  [path: string, method: string, action: string, extraQuery: Record<string, string>, body: object]
> = [
  ['./users/index', 'POST', PermissionAction.AUTH_EXECUTE, {}, { email: 'a@b.c' }],
  [
    './users/[id]/index',
    'PATCH',
    PermissionAction.AUTH_EXECUTE,
    { id: 'u1' },
    { ban_duration: '24h' },
  ],
  ['./users/[id]/index', 'DELETE', PermissionAction.AUTH_EXECUTE, { id: 'u1' }, {}],
  ['./users/[id]/factors', 'DELETE', PermissionAction.AUTH_EXECUTE, { id: 'u1' }, {}],
]

const LINK_ROUTES: Array<[path: string, action: string]> = [
  ['./invite', PermissionAction.AUTH_EXECUTE],
  ['./magiclink', PermissionAction.AUTH_EXECUTE],
  ['./otp', PermissionAction.AUTH_EXECUTE],
  ['./recover', PermissionAction.AUTH_EXECUTE],
]

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  getAdminClientForRef.mockReset().mockResolvedValue(makeAuthAdminClient())
  getAdminContextForRef.mockReset()
  resolveProjectConnection
    .mockReset()
    .mockResolvedValue({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
    })
  fetchPost.mockReset().mockResolvedValue({ ok: true })
})

describe.each(USER_ROUTES)(
  'auth users/[ref]/%s %s guard',
  (path, method, action, extraQuery, body) => {
    it(`declares ${action} and stops on deny before the admin factory is called`, async () => {
      const { handler } = await import(path)
      vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
        res.status(403).json({ message: 'Forbidden' })
        return false
      })
      const { req, res } = createMocks({
        method: method as any,
        query: { ref: 'proj-b', ...extraQuery },
        body,
      })
      await handler(req as any, res as any, { sub: 'g-1' })

      expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
        action,
        projectRef: 'proj-b',
      })
      expect(res._getStatusCode()).toBe(403)
      expect(getAdminClientForRef).not.toHaveBeenCalled()
    })

    it('allows through and reaches the admin factory when guardProjectRoute permits', async () => {
      const { handler } = await import(path)
      vi.mocked(guardProjectRoute).mockResolvedValue(true)
      const { req, res } = createMocks({
        method: method as any,
        query: { ref: 'proj-b', ...extraQuery },
        body,
      })
      await handler(req as any, res as any, { sub: 'g-1' })

      expect(getAdminClientForRef).toHaveBeenCalled()
      expect(res._getStatusCode()).not.toBe(403)
    })
  }
)

describe.each(LINK_ROUTES)('auth link/[ref]/%s guard', (path, action) => {
  it(`declares ${action} and stops on deny before fetchPost is called`, async () => {
    const { handler } = await import(path)
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { email: 'a@b.c', phone: '123' },
    })
    await handler(req as any, res as any, { sub: 'g-1' })

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(fetchPost).not.toHaveBeenCalled()
  })

  it('allows through and reaches fetchPost when guardProjectRoute permits', async () => {
    const { handler } = await import(path)
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { email: 'a@b.c', phone: '123' },
    })
    await handler(req as any, res as any, { sub: 'g-1' })

    expect(fetchPost).toHaveBeenCalled()
    expect(res._getStatusCode()).not.toBe(403)
  })
})
