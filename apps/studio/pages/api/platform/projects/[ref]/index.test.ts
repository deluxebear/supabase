import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import {
  getProjectAttachmentStatus,
  listProjectCapabilities,
} from '@/lib/api/self-platform/attachment'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import { ProjectNotFound, resolveProjectIdentity } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return {
    ProjectNotFound,
    resolveProjectIdentity: vi.fn(),
  }
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermission: vi.fn() }))
vi.mock('@/lib/api/self-platform/attachment', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectAttachmentStatus: vi.fn(),
  listProjectCapabilities: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

// [self-platform] `row` mirrors Task 4's ResolvedConnection.row (PlatformProjectRow | null) — a
// registry hit carries the raw row so index.ts can map it via toProjectDetailResponse without a
// second getProjectByRef query.
const resolved = {
  ref: 'proj-b',
  organizationId: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloudProvider: 'AWS',
  region: 'local',
  pgConnEncrypted: 'ENC',
  pgConnReadOnlyEncrypted: 'ENC_RO',
  supabaseUrl: 'http://kong-b:8000',
  restUrl: 'http://kong-b:8000/rest/v1/',
  dbHost: 'db-b',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  serviceKey: 'SVC',
  anonKey: 'ANON',
  jwtSecret: 'JWT',
  publishableKey: null,
  secretKey: null,
  row: {
    id: 2,
    ref: 'proj-b',
    organization_id: 1,
    name: 'B',
    status: 'ACTIVE_HEALTHY',
    cloud_provider: 'AWS',
    region: 'local',
    db_host: 'db-b',
    db_port: 5432,
    db_name: 'postgres',
    db_user: 'supabase_admin',
    db_user_readonly: 'supabase_read_only_user',
    kong_url: 'http://kong-b:8000',
    rest_url: 'http://kong-b:8000/rest/v1/',
    db_pass_enc: 'x',
    service_key_enc: 'x',
    anon_key_enc: 'x',
    jwt_secret_enc: 'x',
    publishable_key_enc: null,
    secret_key_enc: null,
    endpoint_document: {
      contractVersion: 'v1',
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
          tenantId: 'project-a',
          tlsMode: 'disable',
        },
      },
    },
  },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkPermission).mockResolvedValue(true)
  vi.mocked(getProjectAttachmentStatus).mockResolvedValue(null)
  vi.mocked(listProjectCapabilities).mockResolvedValue([])
})

describe('GET /platform/projects/[ref] (self-platform)', () => {
  it('does not expose the Fleet control plane as the default project', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
    expect(resolveProjectIdentity).not.toHaveBeenCalled()
    expect(checkPermission).not.toHaveBeenCalled()
  })

  it('returns project metadata without a Fleet connectionString', async () => {
    vi.mocked(resolveProjectIdentity).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(resolveProjectIdentity).toHaveBeenCalledWith('proj-b')
    expect(checkPermission).toHaveBeenCalledWith(claimsOf('g-1'), {
      action: PermissionAction.READ,
      resource: 'projects',
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({
      ref: 'proj-b',
      restUrl: 'http://192.168.50.149:8200/rest/v1/',
    })
    expect(res._getJSONData()).not.toHaveProperty('connectionString')
  })
  it('404s an unknown project and never calls checkPermission (resolver 404 wins first)', async () => {
    vi.mocked(resolveProjectIdentity).mockRejectedValue(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
    expect(checkPermission).not.toHaveBeenCalled()
  })
  it('returns 403 Forbidden for a resolvable ref the caller has no read grant on', async () => {
    vi.mocked(resolveProjectIdentity).mockResolvedValue(resolved as any)
    vi.mocked(checkPermission).mockResolvedValue(false)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })
})
