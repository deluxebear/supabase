import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
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

// [self-platform] This file also does a plain top-level `import { ProjectNotFound }`
// from this same module path (below), which forces Vitest to eagerly resolve
// the mocked module before a plain `const resolveProjectConnection = vi.fn()`
// would have initialized — vi.hoisted() avoids that TDZ.
const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

const fetchPost = vi.fn()
vi.mock('@/data/fetchers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPost,
}))

const USER_ROUTES: Array<[string, string, Record<string, string>]> = [
  ['./users/index', 'POST', {}],
  ['./users/[id]/index', 'PATCH', { id: 'u1' }],
  ['./users/[id]/factors', 'DELETE', { id: 'u1' }],
]
const LINK_ROUTES: Array<[string, string]> = [
  ['./invite', '/auth/v1/invite'],
  ['./magiclink', '/auth/v1/magiclink'],
  ['./otp', '/auth/v1/otp'],
  ['./recover', '/auth/v1/recover'],
]

beforeEach(() => {
  getAdminClientForRef.mockReset().mockRejectedValue(new ProjectNotFound('ghost'))
  resolveProjectConnection.mockReset()
  fetchPost.mockReset().mockResolvedValue({ ok: true })
})

describe.each(USER_ROUTES)('auth users per-ref: %s', (path, method, extraQuery) => {
  it('threads ref and 404s unknown ref', async () => {
    const route = (await import(path)).default
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'ghost', ...extraQuery },
      body: {},
    })
    await route(req as any, res as any)
    expect(getAdminClientForRef).toHaveBeenCalledWith('ghost')
    expect(res._getStatusCode()).toBe(404)
  })
})

describe.each(LINK_ROUTES)('auth link per-ref: %s', (path, gotruePath) => {
  it('resolved ref posts to the per-ref GoTrue with the per-ref key', async () => {
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
    })
    const route = (await import(path)).default
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { email: 'a@b.c', phone: '123' },
    })
    await route(req as any, res as any)
    expect(fetchPost.mock.calls[0][0]).toBe(`http://kong-b:8100${gotruePath}`)
    expect(fetchPost.mock.calls[0][2].headers.Authorization).toBe('Bearer service-b')
  })

  it('unknown ref maps to 404 via the apiWrapper net', async () => {
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const route = (await import(path)).default
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'ghost' }, body: {} })
    await route(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(fetchPost).not.toHaveBeenCalled()
  })

  it('unregistered default keeps the global env target', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://kong-global:8000')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-key')
    resolveProjectConnection.mockResolvedValueOnce({ row: null })
    const route = (await import(path)).default
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' }, body: {} })
    await route(req as any, res as any)
    expect(fetchPost.mock.calls[0][0]).toBe(`http://kong-global:8000${gotruePath}`)
    expect(fetchPost.mock.calls[0][2].headers.Authorization).toBe('Bearer global-key')
    vi.unstubAllEnvs()
  })
})
