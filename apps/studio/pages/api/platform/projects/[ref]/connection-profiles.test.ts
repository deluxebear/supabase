import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/projects', () => ({
  getProjectByRef: vi.fn().mockResolvedValue({ db_user_readonly: 'supabase_read_only_user' }),
}))
vi.mock('@/lib/api/self-platform/endpoint-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireProjectEndpointRegistry: vi.fn().mockResolvedValue({
    revision: 3,
    endpoints: {
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
  }),
}))

beforeEach(() => vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true))

describe('Fleet connection profiles APIs', () => {
  it('returns four non-secret profiles', async () => {
    const { handler } = await import('./connection-profiles')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req as never, res as never, { sub: 'owner-a' } as JwtPayload)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.revision).toBe(3)
    expect(
      body.profiles.map(({ id, port }: { id: string; port: number }) => ({ id, port }))
    ).toEqual([
      { id: 'direct', port: 55433 },
      { id: 'transaction', port: 56543 },
      { id: 'session', port: 55432 },
      { id: 'read_only', port: 55433 },
    ])
    expect(JSON.stringify(body)).not.toMatch(/password|secret|kong-project-a/i)
  })

  it('serves the existing Supavisor UI contract with placeholders only', async () => {
    const { handler } = await import('./config/supavisor')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req as never, res as never, { sub: 'owner-a' } as JwtPayload)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(
      body.map(({ pool_mode, db_port }: { pool_mode: string; db_port: number }) => ({
        pool_mode,
        db_port,
      }))
    ).toEqual([
      { pool_mode: 'transaction', db_port: 56543 },
      { pool_mode: 'session', db_port: 55432 },
    ])
    expect(body[0].connection_string).toContain(':[YOUR-PASSWORD]@')
    expect(JSON.stringify(body)).not.toContain('real-password-sentinel')
  })
})
