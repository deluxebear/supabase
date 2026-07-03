import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] This file also does a plain top-level `import { handler }`
// from './index' (which transitively imports this same module via
// apiWrapper), forcing Vitest to eagerly resolve the mocked module before a
// plain `const resolveProjectConnection = vi.fn()` would have initialized —
// vi.hoisted() avoids that TDZ.
const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))
// [self-platform] Task 14: RBAC guards now gate this route. Stub it open so
// this sweep keeps exercising business logic — the guard's own behavior is
// covered by props-rbac.test.ts.
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  guardProjectRoute: vi.fn().mockResolvedValue(true),
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

describe('GET /platform/props/project/{ref} (self-platform)', () => {
  it('returns per-ref project fields with no services', async () => {
    resolveProjectConnection.mockResolvedValueOnce(conn)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.project.ref).toBe('proj-b')
    expect(body.project.name).toBe('B')
    expect(body.project.id).toBe(2)
    expect(body.project.organization_id).toBe(1)
    expect(body.project.cloud_provider).toBe('AWS')
    expect(body.project.status).toBe('ACTIVE_HEALTHY')
    expect(body.project.region).toBe('local')
    expect(body.project.services).toEqual([])
  })

  it('404s unknown ref', async () => {
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
  })
})
