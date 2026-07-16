import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './databases'
import { resolveProjectIdentity } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectIdentity: vi.fn() }
})
// [self-platform] Task 14: RBAC guards now gate this route. Stub it open so
// this sweep keeps exercising business logic — the guard's own behavior is
// covered by databases-rbac.test.ts.
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  guardProjectRoute: vi.fn().mockResolvedValue(true),
}))

const resolved = {
  ref: 'proj-b',
  pgConnEncrypted: 'ENC',
  pgConnReadOnlyEncrypted: 'ENC_RO',
  dbHost: 'db-b',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  restUrl: 'http://kong-b:8000/rest/v1/',
  region: 'local',
  status: 'ACTIVE_HEALTHY',
  // Deliberately distinct from the self-hosted branch's hardcoded 'AWS', to
  // prove the resolved branch reads cloud_provider from the registry row
  // (via ResolvedConnection.cloudProvider) rather than hardcoding it.
  cloudProvider: 'FLY',
  row: {
    endpoint_document: {
      public: {
        apiUrl: 'http://192.168.50.149:8200',
        restUrl: 'http://192.168.50.149:8200/rest/v1/',
        authUrl: 'http://192.168.50.149:8200/auth/v1',
        storageUrl: 'http://192.168.50.149:8200/storage/v1',
        realtimeUrl: 'http://192.168.50.149:8200/realtime/v1',
        functionsUrl: 'http://192.168.50.149:8200/functions/v1',
        s3Url: 'http://192.168.50.149:8200/storage/v1/s3',
        directPostgres: {
          host: '192.168.50.149',
          port: 55433,
          database: 'postgres',
          user: 'postgres',
          tlsMode: 'disable',
        },
        supavisor: {
          host: '192.168.50.149',
          transactionPort: 56543,
          sessionPort: 55432,
          database: 'postgres',
          user: 'postgres',
          tenantId: 'your-tenant-id',
          tlsMode: 'disable',
        },
      },
    },
  },
}
beforeEach(() => vi.clearAllMocks())

describe('GET /platform/projects/[ref]/databases (self-platform)', () => {
  it('returns database metadata without either Fleet connection string', async () => {
    vi.mocked(resolveProjectIdentity).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body[0]).toMatchObject({
      identifier: 'proj-b',
      db_host: '192.168.50.149',
      db_port: 55433,
      status: 'ACTIVE_HEALTHY',
    })
    expect(body[0]).not.toHaveProperty('connectionString')
    expect(body[0]).not.toHaveProperty('connection_string_read_only')
  })

  // [self-platform] CLEANUP — row-source-of-truth: cloud_provider must come
  // from the resolved connection, not be hardcoded to 'AWS'.
  it('uses the resolved connection cloud_provider, not a hardcoded value', async () => {
    vi.mocked(resolveProjectIdentity).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    const body = res._getJSONData()
    expect(body[0].cloud_provider).toBe('FLY')
  })
})
