import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { listMembers } from '@/lib/api/self-platform/members'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/members', () => ({ listMembers: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset()
  vi.mocked(listMembers).mockReset()
})

describe('GET /platform/organizations/{slug}/members (self-platform)', () => {
  it('maps rows to the Member contract (metadata {} required, is_sso_user false)', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })
    vi.mocked(listMembers).mockResolvedValue([
      {
        gotrue_id: 'g-1',
        username: 'admin',
        primary_email: 'admin@internal.test',
        mfa_enabled: true,
        role_ids: [1],
      },
    ])
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'read:Read',
      resource: 'organizations',
    })
    expect(listMembers).toHaveBeenCalledWith(1)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([
      {
        gotrue_id: 'g-1',
        is_sso_user: false,
        metadata: {},
        mfa_enabled: true,
        primary_email: 'admin@internal.test',
        role_ids: [1],
        username: 'admin',
      },
    ])
  })

  it('short-circuits on guard deny — no data access', async () => {
    vi.mocked(guardOrgRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return null
    })
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-0'))
    expect(res._getStatusCode()).toBe(403)
    expect(listMembers).not.toHaveBeenCalled()
  })

  it('405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    expect(guardOrgRoute).not.toHaveBeenCalled()
  })

  it('400 for an array slug', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: ['a', 'b'] } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid slug parameter' })
  })
})
