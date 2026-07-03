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

describe('postgrest config (plain self-hosted, zero-break)', () => {
  it('returns global env jwt_secret; resolver untouched', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('AUTH_JWT_SECRET', 'env-secret')
    // Unset the PGRST_* overrides so the handler emits its documented defaults,
    // making the byte-identity assertion deterministic regardless of ambient env.
    vi.stubEnv('PGRST_DB_EXTRA_SEARCH_PATH', undefined)
    vi.stubEnv('PGRST_DB_SCHEMAS', undefined)
    vi.stubEnv('PGRST_DB_MAX_ROWS', undefined)
    const { handler } = await import('./postgrest')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    // Full byte-identity: the plain self-hosted branch must return the exact
    // historical GetPostgrestConfigResponse literal (PGRST_* defaults), so any
    // future edit that changes a non-secret field in this branch trips this test.
    expect(res._getJSONData()).toEqual({
      db_anon_role: 'anon',
      db_extra_search_path: 'public',
      db_schema: 'public,storage,graphql_public',
      jwt_secret: 'env-secret',
      max_rows: 1000,
      role_claim_key: '.role',
    })
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
