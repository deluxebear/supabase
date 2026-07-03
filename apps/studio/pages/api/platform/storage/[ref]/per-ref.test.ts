import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// resolve-connection 真模块（ProjectNotFound 类要与 apiWrapper 实例检查一致）
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/apiAuthenticate', () => ({
  apiAuthenticate: vi.fn().mockResolvedValue({ sub: 'test-user' }),
}))

// [self-platform] Task 13: RBAC guards now gate these routes. Stub them open
// so this sweep keeps exercising business logic — the guard's own behavior
// is covered by storage-rbac.test.ts.
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  guardProjectRoute: vi.fn().mockResolvedValue(true),
}))

const getAdminClientForRef = vi.fn()
const getAdminContextForRef = vi.fn()
vi.mock('@/lib/api/self-hosted-admin', () => ({
  selfHostedSupabaseAdmin: {},
  getAdminClientForRef,
  getAdminContextForRef,
}))

// [路由文件, HTTP method, 额外 query] —— method 取各路由支持的第一个方法
const ROUTES: Array<[string, string, Record<string, string>]> = [
  ['./buckets/index', 'GET', {}],
  ['./buckets/[id]/index', 'GET', { id: 'b1' }],
  ['./buckets/[id]/empty', 'POST', { id: 'b1' }],
  ['./buckets/[id]/objects/index', 'DELETE', { id: 'b1' }],
  ['./buckets/[id]/objects/list', 'POST', { id: 'b1' }],
  ['./buckets/[id]/objects/download', 'POST', { id: 'b1' }],
  ['./buckets/[id]/objects/move', 'POST', { id: 'b1' }],
  ['./buckets/[id]/objects/public-url', 'POST', { id: 'b1' }],
  ['./buckets/[id]/objects/sign', 'POST', { id: 'b1' }],
  ['./buckets/[id]/objects/sign-multi', 'POST', { id: 'b1' }],
  ['./vector-buckets/index', 'GET', {}],
  ['./vector-buckets/[id]/index', 'GET', { id: 'vb1' }],
  ['./vector-buckets/[id]/indexes/index', 'GET', { id: 'vb1' }],
  ['./vector-buckets/[id]/indexes/[indexName]', 'DELETE', { id: 'vb1', indexName: 'ix' }],
]

beforeEach(() => {
  getAdminClientForRef.mockReset().mockRejectedValue(new ProjectNotFound('ghost'))
  getAdminContextForRef.mockReset().mockRejectedValue(new ProjectNotFound('ghost'))
})

describe.each(ROUTES)('storage per-ref: %s', (path, method, extraQuery) => {
  it('threads ref into the factory and maps unknown ref to 404', async () => {
    const route = (await import(path)).default
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'ghost', ...extraQuery },
      body: {},
    })
    await route(req as any, res as any)
    const factoryCalls = [...getAdminClientForRef.mock.calls, ...getAdminContextForRef.mock.calls]
    expect(factoryCalls.length).toBeGreaterThan(0)
    expect(factoryCalls[0][0]).toBe('ghost')
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })
})

describe('storage per-ref: resolved behavior (worked examples)', () => {
  it('buckets/index lists buckets via the per-ref client', async () => {
    const listBuckets = vi.fn().mockResolvedValue({ data: [{ id: 'b1' }], error: null })
    getAdminClientForRef.mockReset().mockResolvedValue({ storage: { listBuckets } })
    const route = (await import('./buckets/index')).default
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await route(req as any, res as any)
    expect(getAdminClientForRef).toHaveBeenCalledWith('proj-b')
    expect(listBuckets).toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([{ id: 'b1' }])
  })

  it('sign rewrites the signed URL host to the per-ref public base URL', async () => {
    const createSignedUrl = vi
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'http://kong-internal:8000/sig?x=1' }, error: null })
    getAdminContextForRef.mockReset().mockResolvedValue({
      client: { storage: { from: () => ({ createSignedUrl }) } },
      publicBaseUrl: 'http://kong-b.example:8100',
    })
    const route = (await import('./buckets/[id]/objects/sign')).default
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b', id: 'b1' },
      body: { path: 'f.txt' },
    })
    await route(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().signedUrl).toContain('kong-b.example:8100')
  })
})
