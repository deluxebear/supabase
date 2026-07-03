// [self-platform] Task 14: RBAC guard coverage for props/project/[ref]/index
// (the project-summary route; distinct from ./api.ts, which already has its
// own Task 10 checkPermission-based response filtering and is out of scope
// here). Data access: resolveProjectConnection
// (@/lib/api/self-platform/resolve-connection), called explicitly by the
// route body for the response fields.
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

const conn = {
  row: { id: 2 },
  ref: 'proj-b',
  organizationId: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloudProvider: 'AWS',
  region: 'local',
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  resolveProjectConnection.mockReset().mockResolvedValue(conn)
})

describe('props/project/[ref] GET guard', () => {
  it('declares read:Read and stops on deny before resolveProjectConnection', async () => {
    const { handler } = await import('./index')
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
    const { handler } = await import('./index')
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(res._getStatusCode()).toBe(200)
  })
})
