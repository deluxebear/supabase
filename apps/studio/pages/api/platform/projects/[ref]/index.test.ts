import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return {
    ProjectNotFound,
    resolveProjectConnection: vi.fn(),
  }
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermission: vi.fn() }))

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
  },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkPermission).mockResolvedValue(true)
})

describe('GET /platform/projects/[ref] (self-platform)', () => {
  it('returns the resolved project with encrypted connectionString', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(checkPermission).toHaveBeenCalledWith(claimsOf('g-1'), {
      action: PermissionAction.READ,
      resource: 'projects',
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({
      ref: 'proj-b',
      connectionString: 'ENC',
      restUrl: 'http://kong-b:8000/rest/v1/',
    })
  })
  it('404s an unknown project and never calls checkPermission (resolver 404 wins first)', async () => {
    vi.mocked(resolveProjectConnection).mockRejectedValue(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
    expect(checkPermission).not.toHaveBeenCalled()
  })
  it('returns 403 Forbidden for a resolvable ref the caller has no read grant on', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)
    vi.mocked(checkPermission).mockResolvedValue(false)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })
})
