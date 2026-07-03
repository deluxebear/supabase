// [self-platform] Task 14: RBAC guard coverage for databases.ts and
// databases-statuses.ts — both single-method (GET), no method switch, guard
// placed before the single-method body per the task brief.
//
// Data access: databases.ts calls resolveProjectConnection
// (@/lib/api/self-platform/resolve-connection) for the response fields.
// databases-statuses.ts is a contract-minimal stub with NO data access at
// all (M1 single-database fleet) — its deny row only asserts the status
// code.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
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
  cloudProvider: 'AWS',
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  resolveProjectConnection.mockReset().mockResolvedValue(resolved)
})

describe('databases.ts GET guard', () => {
  it('declares read:Read and stops on deny before resolveProjectConnection', async () => {
    const { handler } = await import('./databases')
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: PermissionAction.READ,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })

  it('allows through and reaches resolveProjectConnection when guardProjectRoute permits', async () => {
    const { handler } = await import('./databases')
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(res._getStatusCode()).toBe(200)
  })
})

describe('databases-statuses.ts GET guard', () => {
  it('declares read:Read and stops on deny with 403', async () => {
    const { handler } = await import('./databases-statuses')
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: PermissionAction.READ,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
  })

  it('allows through when guardProjectRoute permits', async () => {
    const { handler } = await import('./databases-statuses')
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(res._getStatusCode()).toBe(200)
  })
})
