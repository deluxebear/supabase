import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './api'
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

beforeEach(() => resolveProjectConnection.mockReset())

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
