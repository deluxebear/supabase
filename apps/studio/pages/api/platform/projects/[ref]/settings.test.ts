// [self-platform] M3.0 Task 10: settings.ts response filtering — a caller
// with read:Read but WITHOUT secrets:Read gets jwt_secret masked and
// service_api_keys filtered to the anon entry only (spec §7.3 risk-2
// hypothesis; masking values may change via a recorded fix task if the
// controller E2E finds frontend breakage — not silently).
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] Fresh module load per test would be overkill here (no env
// permutation under test besides the constant self-platform=true above) —
// mirrors the resolve-connection + enforce mocking pattern used by
// [ref]/index.test.ts and [ref]/config/index.test.ts.
const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermission: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

// [self-platform] Per-action checkPermission behavior — `secrets` controls
// the secrets:Read outcome (masking, not 403); read:Read always resolves true.
const asRole = (secrets: boolean) =>
  vi
    .mocked(checkPermission)
    .mockImplementation(async (_claims, input) =>
      input.action === 'secrets:Read' ? secrets : true
    )

const conn = {
  row: { id: 2 },
  ref: 'proj-b',
  organizationId: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloudProvider: 'AWS',
  region: 'local',
  supabaseUrl: 'http://kong-b.example:8100',
  restUrl: 'http://kong-b.example:8100/rest/v1/',
  dbHost: 'db',
  dbPort: 5432,
  dbName: 'projectb',
  dbUser: 'supabase_admin',
  serviceKey: 'service-b',
  anonKey: 'anon-b',
  jwtSecret: 'jwt-b',
}

// Today's fixture (unchanged admin/Owner shape) — mirrors
// getProjectSettings(resolved) for `conn` above.
const expectedAdmin = {
  app_config: {
    db_schema: 'public',
    endpoint: 'kong-b.example:8100',
    storage_endpoint: 'kong-b.example:8100',
    protocol: 'http',
  },
  cloud_provider: 'AWS',
  db_dns_name: '-',
  db_host: 'db',
  db_ip_addr_config: 'legacy',
  db_name: 'projectb',
  db_port: 5432,
  db_user: 'supabase_admin',
  inserted_at: '2021-08-02T06:40:40.646Z',
  jwt_secret: 'jwt-b',
  name: 'B',
  ref: 'proj-b',
  region: 'local',
  service_api_keys: [
    { api_key: 'anon-b', name: 'anon key', tags: 'anon' },
    { api_key: 'service-b', name: 'service_role key', tags: 'service_role' },
  ],
  ssl_enforced: false,
  status: 'ACTIVE_HEALTHY',
}

beforeEach(() => {
  resolveProjectConnection.mockReset()
  vi.mocked(checkPermission).mockReset()
  // [self-platform] Default: read:Read and secrets:Read both granted.
  asRole(true)
})

describe('GET /platform/projects/[ref]/settings (self-platform)', () => {
  it("admin view (secrets:Read granted): body deep-equals today's fixture, unchanged", async () => {
    asRole(true)
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { handler } = await import('./settings')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual(expectedAdmin)
    expect(checkPermission).toHaveBeenCalledTimes(2)
  })

  it('developer view (secrets:Read denied): jwt_secret masked, service_api_keys filtered to anon only, everything else unchanged', async () => {
    asRole(false)
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { handler } = await import('./settings')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-dev'))
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.jwt_secret).toBe('')
    expect(body.service_api_keys).toHaveLength(1)
    expect(body.service_api_keys[0]).toEqual({ api_key: 'anon-b', name: 'anon key', tags: 'anon' })
    // Deep-equal against the admin fixture with ONLY the two masked fields
    // changed — proves masking doesn't drift any other field.
    expect(body).toEqual({
      ...expectedAdmin,
      jwt_secret: '',
      service_api_keys: [{ api_key: 'anon-b', name: 'anon key', tags: 'anon' }],
    })
  })

  it('zero-role (no read:Read grant): 403 with no body leakage', async () => {
    vi.mocked(checkPermission).mockReset()
    vi.mocked(checkPermission).mockResolvedValue(false)
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { handler } = await import('./settings')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-zero'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })

  it('ghost ref: 404 before checkPermission is invoked', async () => {
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./settings')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
    expect(checkPermission).not.toHaveBeenCalled()
  })
})
