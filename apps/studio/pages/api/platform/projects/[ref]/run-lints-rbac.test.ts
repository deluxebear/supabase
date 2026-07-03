// [self-platform] Task 14: RBAC guard coverage for run-lints. The task
// brief's method table pins this route to GET only (spec §7.3 originally
// said POST — the actual route is GET-only; correction recorded in the
// Task 14 report). Guard is fully mocked; this suite pins (a) the guard is
// invoked with tenant:Sql:Query + projectRef, (b) a deny short-circuits with
// 403 before getLints (@/lib/api/self-hosted/lints), and (c) an allow lets
// it run.
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

const { getLints } = vi.hoisted(() => ({ getLints: vi.fn() }))
vi.mock('@/lib/api/self-hosted/lints', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLints,
}))

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  getLints.mockReset().mockResolvedValue({ data: [], error: undefined })
})

describe('run-lints GET guard', () => {
  it('declares tenant:Sql:Query and stops on deny before getLints', async () => {
    const { handler } = await import('./run-lints')
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: PermissionAction.TENANT_SQL_QUERY,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(getLints).not.toHaveBeenCalled()
  })

  it('allows through and reaches getLints when guardProjectRoute permits', async () => {
    const { handler } = await import('./run-lints')
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(getLints).toHaveBeenCalledTimes(1)
    expect(res._getStatusCode()).toBe(200)
  })
})
