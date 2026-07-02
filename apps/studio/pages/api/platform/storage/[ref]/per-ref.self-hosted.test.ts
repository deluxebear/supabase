import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

// 与 per-ref.test.ts 完全相同的 14 元组清单（逐字复制）
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

afterEach(() => vi.unstubAllEnvs())

describe.each(ROUTES)('storage zero-break: %s', (path, method, extraQuery) => {
  it('plain self-hosted never touches the resolver', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('SUPABASE_URL', 'http://kong:8000')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-key')
    vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://localhost:8000')
    const route = (await import(path)).default
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'default', ...extraQuery },
      body: {},
    })
    await route(req as any, res as any)
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
