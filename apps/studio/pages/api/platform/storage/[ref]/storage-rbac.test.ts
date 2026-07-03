// [self-platform] Task 13: table-driven RBAC guard coverage for the 14
// storage [ref] routes (buckets, vector-buckets, and their nested
// sub-resources). Mirrors pg-meta/[ref]/rbac-guards.test.ts's shape, but is
// method-aware per file (each file's RBAC_ACTIONS map can gate more than one
// HTTP verb, sometimes with different actions per verb).
//
// Read-semantics reminder for reviewers: storage:Read-tier POSTs (download,
// list, sign, sign-multi, public-url) MUST stay reachable by Read-only
// members per the permission matrix — that real-role behavior is pinned by
// Task 4's matrix tests, NOT here. Here guardProjectRoute is fully mocked;
// we only assert (a) the guard is invoked with the table's action +
// projectRef, (b) a deny short-circuits with 403 before the admin-client
// factory is touched, and (c) an allow lets the factory get called.
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

// A fully-populated fake storage client so the "allow" path can run each
// route's real business logic to completion without throwing — the guard
// (not the business logic) is what this suite pins.
const makeStorageClient = () => ({
  storage: {
    listBuckets: vi.fn().mockResolvedValue({ data: [], error: null }),
    createBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
    getBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
    updateBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
    deleteBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
    emptyBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
    from: vi.fn().mockReturnValue({
      download: vi
        .fn()
        .mockResolvedValue({ data: { arrayBuffer: async () => new ArrayBuffer(0) }, error: null }),
      remove: vi.fn().mockResolvedValue({ data: [], error: null }),
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
      move: vi.fn().mockResolvedValue({ data: {}, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'http://kong-internal:8000/object/public/b1/f.txt' },
      }),
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: 'http://kong-internal:8000/sign?x=1' },
        error: null,
      }),
      createSignedUrls: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
    vectors: {
      listBuckets: vi.fn().mockResolvedValue({ data: [], error: null }),
      createBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
      getBucket: vi.fn().mockResolvedValue({ data: { vectorBucket: {} }, error: null }),
      deleteBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
      from: vi.fn().mockReturnValue({
        listIndexes: vi
          .fn()
          .mockResolvedValue({ data: { indexes: [], nextToken: null }, error: null }),
        getIndex: vi.fn().mockResolvedValue({ data: { index: {} } }),
        createIndex: vi.fn().mockResolvedValue({ data: {}, error: null }),
        deleteIndex: vi.fn().mockResolvedValue({ data: {}, error: null }),
      }),
    },
  },
})

type Factory = 'client' | 'context'

const ROUTES: Array<
  [
    path: string,
    method: string,
    action: string,
    factory: Factory,
    extraQuery: Record<string, string>,
    body: object,
  ]
> = [
  ['./buckets/index', 'GET', PermissionAction.STORAGE_ADMIN_READ, 'client', {}, {}],
  ['./buckets/index', 'POST', PermissionAction.STORAGE_ADMIN_WRITE, 'client', {}, { id: 'b1' }],
  ['./buckets/[id]/index', 'GET', PermissionAction.STORAGE_ADMIN_READ, 'client', { id: 'b1' }, {}],
  [
    './buckets/[id]/index',
    'PATCH',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    { id: 'b1' },
    {},
  ],
  [
    './buckets/[id]/index',
    'DELETE',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    { id: 'b1' },
    {},
  ],
  [
    './buckets/[id]/empty',
    'POST',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    { id: 'b1' },
    {},
  ],
  [
    './buckets/[id]/objects/download',
    'POST',
    PermissionAction.STORAGE_READ,
    'client',
    { id: 'b1' },
    { path: 'f.txt' },
  ],
  [
    './buckets/[id]/objects/index',
    'DELETE',
    PermissionAction.STORAGE_WRITE,
    'client',
    { id: 'b1' },
    { paths: ['f.txt'] },
  ],
  [
    './buckets/[id]/objects/list',
    'POST',
    PermissionAction.STORAGE_READ,
    'client',
    { id: 'b1' },
    {},
  ],
  [
    './buckets/[id]/objects/move',
    'POST',
    PermissionAction.STORAGE_WRITE,
    'client',
    { id: 'b1' },
    { from: 'a.txt', to: 'b.txt' },
  ],
  [
    './buckets/[id]/objects/public-url',
    'POST',
    PermissionAction.STORAGE_READ,
    'context',
    { id: 'b1' },
    { path: 'f.txt' },
  ],
  [
    './buckets/[id]/objects/sign-multi',
    'POST',
    PermissionAction.STORAGE_READ,
    'context',
    { id: 'b1' },
    { path: ['f.txt'] },
  ],
  [
    './buckets/[id]/objects/sign',
    'POST',
    PermissionAction.STORAGE_READ,
    'context',
    { id: 'b1' },
    { path: 'f.txt' },
  ],
  ['./vector-buckets/index', 'GET', PermissionAction.STORAGE_ADMIN_READ, 'client', {}, {}],
  [
    './vector-buckets/index',
    'POST',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    {},
    { bucketName: 'vb1' },
  ],
  [
    './vector-buckets/[id]/index',
    'GET',
    PermissionAction.STORAGE_ADMIN_READ,
    'client',
    { id: 'vb1' },
    {},
  ],
  [
    './vector-buckets/[id]/index',
    'DELETE',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    { id: 'vb1' },
    {},
  ],
  [
    './vector-buckets/[id]/indexes/index',
    'GET',
    PermissionAction.STORAGE_ADMIN_READ,
    'client',
    { id: 'vb1' },
    {},
  ],
  [
    './vector-buckets/[id]/indexes/index',
    'POST',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    { id: 'vb1' },
    { indexName: 'ix', dataType: 'float32', dimension: 3 },
  ],
  [
    './vector-buckets/[id]/indexes/[indexName]',
    'DELETE',
    PermissionAction.STORAGE_ADMIN_WRITE,
    'client',
    { id: 'vb1', indexName: 'ix' },
    {},
  ],
]

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  getAdminClientForRef.mockReset().mockResolvedValue(makeStorageClient())
  getAdminContextForRef
    .mockReset()
    .mockResolvedValue({ client: makeStorageClient(), publicBaseUrl: 'http://kong-b.example:8100' })
})

describe.each(ROUTES)(
  'storage/[ref]/%s %s guard',
  (path, method, action, factory, extraQuery, body) => {
    const factoryFn = () => (factory === 'client' ? getAdminClientForRef : getAdminContextForRef)

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
      expect(getAdminContextForRef).not.toHaveBeenCalled()
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

      expect(factoryFn()).toHaveBeenCalled()
      expect(res._getStatusCode()).not.toBe(403)
    })
  }
)
