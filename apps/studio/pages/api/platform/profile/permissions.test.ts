import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './permissions'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { expandPermissions } from '@/lib/api/self-platform/rbac/expand'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/members', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMemberContext: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const OWNER_CTX = {
  gotrueId: 'g-1',
  roles: [
    {
      id: 1,
      baseRoleId: 1,
      baseRoleName: 'Owner',
      name: 'Owner',
      orgId: 1,
      orgSlug: 'default',
      projectRefs: [],
      projectIds: [],
    },
  ],
}

describe('GET /platform/profile/permissions (M3.0)', () => {
  beforeEach(() => vi.mocked(getMemberContext).mockReset())

  it('expands the member roles through the real matrix', async () => {
    vi.mocked(getMemberContext).mockResolvedValue(OWNER_CTX)
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req, res, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    // Response equals the real expansion — not a hand-rolled wildcard.
    expect(res._getJSONData()).toEqual(JSON.parse(JSON.stringify(expandPermissions(OWNER_CTX))))
    expect(vi.mocked(getMemberContext)).toHaveBeenCalledWith('g-1')
  })

  it('zero-role member gets an empty grant list (fail closed)', async () => {
    vi.mocked(getMemberContext).mockResolvedValue({ gotrueId: 'g-2', roles: [] })
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req, res, claimsOf('g-2'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([])
  })

  it('401 without token claims', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req, res, undefined)
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData()).toEqual({ message: 'Unauthorized: missing token claims' })
    expect(vi.mocked(getMemberContext)).not.toHaveBeenCalled()
  })

  it('405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req, res, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
  })
})
