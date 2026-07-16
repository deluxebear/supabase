import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CapabilityUnavailable } from '@/lib/api/self-platform/attachment'
import { EndpointRevisionConflict } from '@/lib/api/self-platform/endpoint-registry'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/attachment', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireProjectCapability: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/endpoint-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectEndpointRegistry: vi.fn(),
  updateProjectEndpointRegistry: vi.fn(),
}))

const endpoints = {
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
} as const

beforeEach(async () => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  const attachment = await import('@/lib/api/self-platform/attachment')
  vi.mocked(attachment.requireProjectCapability).mockReset().mockResolvedValue(undefined)
  const registry = await import('@/lib/api/self-platform/endpoint-registry')
  vi.mocked(registry.getProjectEndpointRegistry)
    .mockReset()
    .mockResolvedValue({ revision: 2, endpoints })
  vi.mocked(registry.updateProjectEndpointRegistry)
    .mockReset()
    .mockResolvedValue({ revision: 3, endpoints })
})

describe('Fleet project endpoint registry API', () => {
  it('returns only the public endpoint projection', async () => {
    const { handler } = await import('./endpoints')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req as never, res as never, { sub: 'owner-a' } as JwtPayload)

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ revision: 2, endpoints })
    expect(guardProjectRoute).toHaveBeenCalledWith(
      res,
      expect.anything(),
      expect.objectContaining({ action: PermissionAction.READ, projectRef: 'project-a' })
    )
    expect(JSON.stringify(res._getJSONData())).not.toContain('kong-project-a')
  })

  it('updates with an expected connection revision and no credentials', async () => {
    const { handler } = await import('./endpoints')
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'project-a' },
      body: { expectedRevision: 2, endpoints },
    })
    await handler(req as never, res as never, { sub: 'owner-a' } as JwtPayload)

    expect(res._getStatusCode()).toBe(200)
    const registry = await import('@/lib/api/self-platform/endpoint-registry')
    expect(registry.updateProjectEndpointRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: 'project-a',
        expectedRevision: 2,
        endpoints,
        actor: 'owner-a',
      })
    )
  })

  it('returns a stable conflict when another writer advanced the revision', async () => {
    const registry = await import('@/lib/api/self-platform/endpoint-registry')
    vi.mocked(registry.updateProjectEndpointRegistry).mockRejectedValueOnce(
      new EndpointRevisionConflict()
    )
    const { handler } = await import('./endpoints')
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'project-a' },
      body: { expectedRevision: 2, endpoints },
    })
    await handler(req as never, res as never, { sub: 'owner-a' } as JwtPayload)

    expect(res._getStatusCode()).toBe(409)
    expect(res._getJSONData().code).toBe('connection_revision_conflict')
  })

  it('rechecks the project capability before the CAS mutation', async () => {
    const attachment = await import('@/lib/api/self-platform/attachment')
    vi.mocked(attachment.requireProjectCapability).mockRejectedValueOnce(
      new CapabilityUnavailable('project.connection.update', [
        { code: 'agent_unavailable', message: 'Agent unavailable.' },
      ])
    )
    const { handler } = await import('./endpoints')
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'project-a' },
      body: { expectedRevision: 2, endpoints },
    })
    await handler(req as never, res as never, { sub: 'owner-a' } as JwtPayload)

    expect(res._getStatusCode()).toBe(409)
    expect(res._getJSONData().code).toBe('capability_unavailable')
  })
})
