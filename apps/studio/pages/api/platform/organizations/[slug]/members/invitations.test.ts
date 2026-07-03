import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './invitations'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset()
})

describe('GET /platform/organizations/{slug}/members/invitations (self-platform, M3.2 stub)', () => {
  it('returns the empty wrapper object (contract InvitationResponse)', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'read:Read',
      resource: 'organizations',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ invitations: [] })
  })

  it('guard denies propagate (members query Promise.all depends on this route)', async () => {
    vi.mocked(guardOrgRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return null
    })
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-0'))
    expect(res._getStatusCode()).toBe(403)
  })

  it('405 for non-GET; 400 for array slug', async () => {
    const post = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(post.req as never, post.res as never, claimsOf('g-1'))
    expect(post.res._getStatusCode()).toBe(405)
    expect(guardOrgRoute).not.toHaveBeenCalled()
    const arr = createMocks({ method: 'GET', query: { slug: ['a', 'b'] } })
    await handler(arr.req as never, arr.res as never, claimsOf('g-1'))
    expect(arr.res._getStatusCode()).toBe(400)
    expect(arr.res._getJSONData()).toEqual({ message: 'Invalid slug parameter' })
  })
})
