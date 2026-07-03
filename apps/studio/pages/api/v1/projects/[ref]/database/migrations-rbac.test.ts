// [self-platform] Task 14: table-driven RBAC guard coverage for the
// migrations route. Guard is fully mocked (its own decision logic is
// covered by enforce.test.ts); this suite pins (a) the guard is invoked with
// the table's action + projectRef, (b) a deny short-circuits with 403 before
// the route's data-access call (listMigrationVersions / applyAndTrackMigrations,
// both from @/lib/api/self-hosted/migrations), and (c) an allow lets it run.
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

const { listMigrationVersions, applyAndTrackMigrations } = vi.hoisted(() => ({
  listMigrationVersions: vi.fn(),
  applyAndTrackMigrations: vi.fn(),
}))
vi.mock('@/lib/api/self-hosted/migrations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listMigrationVersions,
  applyAndTrackMigrations,
}))

const ROUTES: Array<[method: string, action: string, dataAccess: 'list' | 'apply']> = [
  ['GET', PermissionAction.TENANT_SQL_ADMIN_READ, 'list'],
  ['POST', PermissionAction.TENANT_SQL_CREATE_TABLE, 'apply'],
]

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  listMigrationVersions.mockReset().mockResolvedValue({ data: [], error: undefined })
  applyAndTrackMigrations.mockReset().mockResolvedValue({ data: [], error: undefined })
})

describe.each(ROUTES)('database/migrations %s guard', (method, action, dataAccess) => {
  const dataAccessFn = dataAccess === 'list' ? listMigrationVersions : applyAndTrackMigrations

  it(`declares ${action} and stops on deny before ${dataAccess === 'list' ? 'listMigrationVersions' : 'applyAndTrackMigrations'}`, async () => {
    const { handler } = await import('./migrations')
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'proj-b' },
      body: { query: 'select 1', name: 'm' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(dataAccessFn).not.toHaveBeenCalled()
  })

  it('allows through and reaches data access when guardProjectRoute permits', async () => {
    const { handler } = await import('./migrations')
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'proj-b' },
      body: { query: 'select 1', name: 'm' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(dataAccessFn).toHaveBeenCalledTimes(1)
    expect(res._getStatusCode()).not.toBe(403)
  })
})
