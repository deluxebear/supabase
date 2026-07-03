import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './api'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_ENDPOINT } from '@/lib/constants/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  // [self-platform] Public-host global used by the "unregistered default"
  // case below — must stay distinct from any service-internal url a test
  // uses for conn.supabaseUrl so the two can't be confused.
  process.env.SUPABASE_PUBLIC_URL = 'http://public-host.example:8000'
})

// [self-platform] This file also does a plain top-level `import { handler }`
// from './api' (which transitively imports this same module via apiWrapper),
// forcing Vitest to eagerly resolve the mocked module before a plain
// `const resolveProjectConnection = vi.fn()` would have initialized —
// vi.hoisted() avoids that TDZ.
const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermission: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

// [self-platform] Task 10: per-action checkPermission behavior. `secrets`
// controls the secrets:Read outcome (masking, not 403); every other action
// (read:Read, the visibility guard) resolves true.
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
}

beforeEach(() => {
  resolveProjectConnection.mockReset()
  vi.mocked(checkPermission).mockReset()
  // [self-platform] Task 10 default: read:Read and secrets:Read both granted
  // — pre-M3.0 tests below exercise no RBAC denial and must stay green.
  asRole(true)
})

describe('GET /platform/props/project/{ref}/api (self-platform)', () => {
  it('returns per-ref keys and a bare-host endpoint', async () => {
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.autoApiService.defaultApiKey).toBe('anon-b')
    expect(body.autoApiService.serviceApiKey).toBe('service-b')
    expect(body.autoApiService.endpoint).toBe('kong-b.example:8100')
    expect(body.autoApiService.protocol).toBe('http')
    expect(body.autoApiService.restUrl).toBe('http://kong-b.example:8100/rest/v1/')
    expect(body.autoApiService.project.ref).toBe('proj-b')
    expect(body.project.db_name).toBe('projectb')
  })

  it('404s unknown ref', async () => {
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
  })

  it('unregistered default keeps public-host globals', async () => {
    // [self-platform] resolveProjectConnection's fromGlobalEnv() sets
    // supabaseUrl = process.env.SUPABASE_URL (service-INTERNAL, e.g.
    // kong:8000) for an unregistered 'default' — row is null. The handler
    // must NOT derive endpoint/protocol from that internal url; it must
    // keep the PROJECT_ENDPOINT public-host global instead.
    resolveProjectConnection.mockResolvedValueOnce({
      row: null,
      ref: 'default',
      organizationId: null,
      name: 'Default Project',
      status: 'ACTIVE_HEALTHY',
      cloudProvider: 'AWS',
      region: 'local',
      supabaseUrl: 'http://kong-internal:8000',
      restUrl: '',
      dbHost: 'db',
      dbPort: 5432,
      dbName: 'postgres',
      dbUser: 'supabase_admin',
      serviceKey: '',
      anonKey: '',
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.autoApiService.endpoint).toBe(PROJECT_ENDPOINT)
    expect(body.autoApiService.endpoint).not.toBe('kong-internal:8000')
  })
})

// [self-platform] Task 10: response filtering — secrets:Read denial masks
// autoApiService.serviceApiKey (defaultApiKey/anon stays) without disturbing
// any other field. Two checkPermission calls per request (read + secrets).
describe('GET /platform/props/project/{ref}/api — secrets masking (self-platform, M3.0 Task 10)', () => {
  const expectedAdmin = {
    project: {
      id: 2,
      ref: 'proj-b',
      name: 'B',
      organization_id: 1,
      cloud_provider: 'AWS',
      status: 'ACTIVE_HEALTHY',
      region: 'local',
      inserted_at: '2021-08-02T06:40:40.646Z',
      api_key_supabase_encrypted: '',
      db_host: 'db',
      db_name: 'projectb',
      db_port: 5432,
      db_ssl: false,
      db_user: 'supabase_admin',
      services: [
        {
          id: 1,
          name: 'Default API',
          app: { id: 1, name: 'Auto API' },
          app_config: {
            db_schema: 'public',
            endpoint: 'kong-b.example:8100',
            realtime_enabled: true,
          },
          service_api_keys: [
            { api_key_encrypted: '-', name: 'service_role key', tags: 'service_role' },
            { api_key_encrypted: '-', name: 'anon key', tags: 'anon' },
          ],
        },
      ],
    },
    autoApiService: {
      id: 1,
      name: 'Default API',
      project: { ref: 'proj-b' },
      app: { id: 1, name: 'Auto API' },
      app_config: { db_schema: 'public', endpoint: 'kong-b.example:8100', realtime_enabled: true },
      protocol: 'http',
      endpoint: 'kong-b.example:8100',
      restUrl: 'http://kong-b.example:8100/rest/v1/',
      defaultApiKey: 'anon-b',
      serviceApiKey: 'service-b',
      service_api_keys: [
        { api_key_encrypted: '-', name: 'service_role key', tags: 'service_role' },
        { api_key_encrypted: '-', name: 'anon key', tags: 'anon' },
      ],
    },
  }

  it('admin view (secrets:Read granted): byte-identical to the unfiltered fixture', async () => {
    asRole(true)
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual(expectedAdmin)
    expect(checkPermission).toHaveBeenCalledTimes(2)
  })

  it('developer view (secrets:Read denied): serviceApiKey masked, defaultApiKey and every other field unchanged', async () => {
    asRole(false)
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-dev'))
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.autoApiService.serviceApiKey).toBe('')
    expect(body.autoApiService.defaultApiKey).toBe('anon-b')
    // Deep-equal against the admin fixture with ONLY serviceApiKey masked —
    // proves masking doesn't drift any other field.
    expect(body).toEqual({
      ...expectedAdmin,
      autoApiService: { ...expectedAdmin.autoApiService, serviceApiKey: '' },
    })
  })

  it('zero-role (no read:Read grant): 403 with no body leakage', async () => {
    vi.mocked(checkPermission).mockReset()
    vi.mocked(checkPermission).mockResolvedValue(false)
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-zero'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })

  it('ghost ref: 404 before checkPermission is invoked', async () => {
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(checkPermission).not.toHaveBeenCalled()
  })
})
