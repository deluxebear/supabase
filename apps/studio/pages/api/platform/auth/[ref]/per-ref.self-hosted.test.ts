import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// [self-platform] Force IS_SELF_PLATFORM false at module-eval time — hoisted
// so it lands before any route file (and the self-platform constant module)
// is imported.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = ''
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/apiAuthenticate', () => ({
  apiAuthenticate: vi.fn().mockResolvedValue({ sub: 'test-user' }),
}))

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

// Union of Task 6's USER_ROUTES + LINK_ROUTES file paths (per-ref.test.ts) —
// same 7 routes, closed-mode (plain self-hosted) sweep.
const ROUTES: Array<[string, string, Record<string, string>]> = [
  ['./users/index', 'POST', {}],
  ['./users/[id]/index', 'PATCH', { id: 'u1' }],
  ['./users/[id]/factors', 'DELETE', { id: 'u1' }],
  ['./invite', 'POST', {}],
  ['./magiclink', 'POST', {}],
  ['./otp', 'POST', {}],
  ['./recover', 'POST', {}],
]

beforeEach(() => {
  // Factory + fetchPost stay mocked (same doubles as per-ref.test.ts) so a
  // plain-self-hosted run never makes a real network call.
  getAdminClientForRef.mockReset().mockResolvedValue({
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
  getAdminContextForRef.mockReset()
  resolveProjectConnection.mockReset()
  fetchPost.mockReset().mockResolvedValue({ ok: true })
})

describe.each(ROUTES)('auth zero-break: %s', (path, method, extraQuery) => {
  it('plain self-hosted never touches the resolver', async () => {
    const route = (await import(path)).default
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'default', ...extraQuery },
      body: { email: 'a@b.c', phone: '123' },
    })
    await route(req as any, res as any)
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
