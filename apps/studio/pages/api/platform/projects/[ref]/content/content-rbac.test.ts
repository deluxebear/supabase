// [self-platform] Task 14: table-driven RBAC guard coverage for the 5
// content (user-content/snippets) [ref] routes. Guard is fully mocked here
// (its own decision logic is covered by enforce.test.ts); this suite pins
// (a) the guard is invoked with the table's action + resource:'user_content'
// + projectRef, (b) a deny short-circuits with 403 before the route's first
// filesystem/store data-access call (@/lib/api/snippets.utils), and (c) an
// allow lets that data access run.
//
// folders/[id].ts's PATCH is a stub ("Platform specific endpoint" — no
// data-access call at all); its deny/allow rows only assert status codes.
//
// The ghost-ref 404 behavior change (guard now resolves refs these routes
// previously ignored) is covered separately in content-per-ref.test.ts,
// which exercises the real guardProjectRoute.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const {
  getSnippets,
  getSnippet,
  getFolders,
  createFolder,
  deleteFolder,
  saveSnippet,
  updateSnippet,
  deleteSnippet,
} = vi.hoisted(() => ({
  getSnippets: vi.fn(),
  getSnippet: vi.fn(),
  getFolders: vi.fn(),
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  saveSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
}))
vi.mock('@/lib/api/snippets.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSnippets,
  getSnippet,
  getFolders,
  createFolder,
  deleteFolder,
  saveSnippet,
  updateSnippet,
  deleteSnippet,
}))

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  getSnippets.mockReset().mockResolvedValue({ cursor: undefined, snippets: [] })
  getSnippet.mockReset().mockResolvedValue({ id: 's1' })
  getFolders.mockReset().mockResolvedValue([])
  createFolder.mockReset().mockResolvedValue({ id: 'f1', name: 'f' })
  deleteFolder.mockReset().mockResolvedValue(undefined)
  saveSnippet.mockReset().mockResolvedValue({ id: 's1' })
  updateSnippet.mockReset().mockResolvedValue({ id: 's1' })
  deleteSnippet.mockReset().mockResolvedValue(undefined)
})

type Row = [
  path: string,
  method: string,
  action: string,
  dataAccess: (() => unknown) | null,
  query: Record<string, string>,
  body: object,
]

const ROUTES: Row[] = [
  ['./count', 'GET', PermissionAction.READ, () => getSnippets, {}, {}],
  ['./item/[id]', 'GET', PermissionAction.READ, () => getSnippet, { id: 's1' }, {}],
  ['./folders/[id]', 'GET', PermissionAction.READ, () => getFolders, { id: 'f1' }, {}],
  ['./folders/[id]', 'PATCH', PermissionAction.UPDATE, null, { id: 'f1' }, {}],
  ['./folders/index', 'GET', PermissionAction.READ, () => getFolders, {}, {}],
  ['./folders/index', 'POST', PermissionAction.CREATE, () => createFolder, {}, { name: 'f' }],
  ['./folders/index', 'DELETE', PermissionAction.DELETE, () => deleteFolder, { ids: 'f1' }, {}],
  ['./index', 'GET', PermissionAction.READ, () => getSnippets, {}, {}],
  ['./index', 'PUT', PermissionAction.UPDATE, () => updateSnippet, {}, { id: 's1' }],
  [
    './index',
    'DELETE',
    PermissionAction.DELETE,
    () => deleteSnippet,
    { ids: '11111111-1111-1111-1111-111111111111' },
    {},
  ],
]

describe.each(ROUTES)(
  'content %s %s guard',
  (path, method, action, dataAccessFactory, query, body) => {
    it(`declares ${action} with resource 'user_content' and stops on deny before data access`, async () => {
      const { handler } = await import(path)
      vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
        res.status(403).json({ message: 'Forbidden' })
        return false
      })
      const { req, res } = createMocks({
        method: method as any,
        query: { ref: 'proj-b', ...query },
        body,
      })
      await handler(req as any, res as any, { sub: 'g-1' })

      expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
        action,
        resource: 'user_content',
        projectRef: 'proj-b',
      })
      expect(res._getStatusCode()).toBe(403)
      if (dataAccessFactory) {
        expect(dataAccessFactory()).not.toHaveBeenCalled()
      }
    })

    it('allows through when guardProjectRoute permits', async () => {
      const { handler } = await import(path)
      vi.mocked(guardProjectRoute).mockResolvedValue(true)
      const { req, res } = createMocks({
        method: method as any,
        query: { ref: 'proj-b', ...query },
        body,
      })
      await handler(req as any, res as any, { sub: 'g-1' })

      expect(res._getStatusCode()).not.toBe(403)
      if (dataAccessFactory) {
        expect(dataAccessFactory()).toHaveBeenCalled()
      }
    })
  }
)
