import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './enforcement'
import { getOrgMfaEnforced, setOrgMfaEnforced } from '@/lib/api/self-platform/organizations'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/organizations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgMfaEnforced: vi.fn(),
  setOrgMfaEnforced: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset().mockResolvedValue({ orgId: 1, orgSlug: 'default' })
  vi.mocked(getOrgMfaEnforced).mockReset().mockResolvedValue(false)
  vi.mocked(setOrgMfaEnforced).mockReset()
})

describe('GET/PATCH .../members/mfa/enforcement (self-platform)', () => {
  it('GET is read-gated and returns 201 {enforced} (contract puts the response on 201)', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      action: 'read:Read',
      resource: 'organizations',
    })
    expect(res._getStatusCode()).toBe(201)
    expect(res._getJSONData()).toEqual({ enforced: false })
  })

  it('PATCH is gated write:Update organizations (matrix restrictive => Owner-only) and persists', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { slug: 'default' },
      body: { enforced: true },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Update',
      resource: 'organizations',
    })
    expect(setOrgMfaEnforced).toHaveBeenCalledWith(1, true)
    expect(res._getStatusCode()).toBe(201)
    expect(res._getJSONData()).toEqual({ enforced: true })
  })

  it('PATCH 400 for a non-boolean body', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { slug: 'default' },
      body: { enforced: 'yes' },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid enforced parameter' })
    expect(setOrgMfaEnforced).not.toHaveBeenCalled()
  })

  it('405 for POST; 400 for array slug', async () => {
    const post = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(post.req as never, post.res as never, claimsOf('g-1'))
    expect(post.res._getStatusCode()).toBe(405)
    const arr = createMocks({ method: 'GET', query: { slug: ['a'] } })
    await handler(arr.req as never, arr.res as never, claimsOf('g-1'))
    expect(arr.res._getStatusCode()).toBe(400)
  })
})
