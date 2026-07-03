// [self-platform] Task 14: content routes previously ignored `ref` entirely
// (they read/write the local filesystem snippet store with no per-project
// scoping). Adding the RBAC guard is a behavior change in self-platform: the
// guard resolves the ref FIRST (spec §7.2, 404-before-403), so an unknown
// ref now 404s before these routes ever touch the filesystem — where before
// it would have silently served/mutated the shared local store.
//
// This file uses the REAL guardProjectRoute (not mocked) with only
// resolveProjectConnection stubbed to reject for the ghost ref, so
// checkPermission is never reached — proving the 404 is resolver-backed,
// not a permission decision. Guard behavior itself (action/resource
// wiring, allow/deny) is covered by content-rbac.test.ts.
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] These routes go through the default (apiWrapper-wrapped)
// export, which authenticates under IS_SELF_PLATFORM — stub it so this
// suite exercises the guard's 404-before-403, not auth.
vi.mock('@/lib/api/apiAuthenticate', () => ({
  apiAuthenticate: vi.fn().mockResolvedValue({ sub: 'test-user' }),
}))

const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

const { getSnippets, getSnippet, getFolders } = vi.hoisted(() => ({
  getSnippets: vi.fn(),
  getSnippet: vi.fn(),
  getFolders: vi.fn(),
}))
vi.mock('@/lib/api/snippets.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSnippets,
  getSnippet,
  getFolders,
}))

beforeEach(async () => {
  const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
  resolveProjectConnection.mockReset().mockRejectedValue(new ProjectNotFound('ghost'))
  getSnippets.mockReset()
  getSnippet.mockReset()
  getFolders.mockReset()
})

const ROUTES: Array<[path: string, method: string, query: Record<string, string>]> = [
  ['./count', 'GET', {}],
  ['./item/[id]', 'GET', { id: 's1' }],
  ['./folders/[id]', 'GET', { id: 'f1' }],
  ['./folders/index', 'GET', {}],
  ['./index', 'GET', {}],
]

describe.each(ROUTES)('content per-ref: %s', (path, method, query) => {
  it('maps an unknown ref to 404 via the guard, before touching the snippet store', async () => {
    const route = (await import(path)).default
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'ghost', ...query },
    })
    await route(req as any, res as any)

    expect(resolveProjectConnection).toHaveBeenCalledWith('ghost')
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
    expect(getSnippets).not.toHaveBeenCalled()
    expect(getSnippet).not.toHaveBeenCalled()
    expect(getFolders).not.toHaveBeenCalled()
  })
})
