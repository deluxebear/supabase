import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './api'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
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
})
