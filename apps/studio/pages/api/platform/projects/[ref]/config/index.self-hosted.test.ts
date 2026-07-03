import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => {
  const original = await importOriginal<object>()
  return {
    ...original,
    resolveProjectConnection,
  }
})

afterEach(() => vi.unstubAllEnvs())

describe('config (plain self-hosted, zero-break)', () => {
  it('returns global env jwt_secret; resolver untouched', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('AUTH_JWT_SECRET', 'env-secret')
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    // Full byte-identity: the plain self-hosted branch must return the exact
    // historical literal, so any future edit that changes a non-secret field
    // in this branch trips this test.
    expect(res._getJSONData()).toEqual({
      db_anon_role: 'anon',
      db_extra_search_path: 'public',
      db_schema: 'public, storage',
      jwt_secret: 'env-secret',
      max_rows: 100,
      role_claim_key: '.role',
    })
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
