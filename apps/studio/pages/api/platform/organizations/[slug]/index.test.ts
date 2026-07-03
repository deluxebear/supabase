import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import {
  getOrganizationBySlug,
  listOrganizationsForProfile,
} from '@/lib/api/self-platform/organizations'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/organizations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listOrganizationsForProfile: vi.fn(),
  getOrganizationBySlug: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const ROW = { id: 1, slug: 'default', name: 'Default Organization' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /platform/organizations/{slug} (self-platform)', () => {
  it('returns the org detail (existing shape) for a member', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([ROW])
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(listOrganizationsForProfile).toHaveBeenCalledWith('g-1')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({
      id: 1,
      slug: 'default',
      name: 'Default Organization',
      has_oriole_project: false,
    })
  })

  it('returns 404 for a non-member and does not call getOrganizationBySlug', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([ROW])
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'other' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Organization not found' })
    expect(getOrganizationBySlug).not.toHaveBeenCalled()
  })

  it('returns 401 without token claims', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as any, res as any, undefined)
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData()).toEqual({ message: 'Unauthorized: missing token claims' })
    expect(listOrganizationsForProfile).not.toHaveBeenCalled()
  })

  it('returns 405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
  })

  it('returns 400 for an array-valued slug parameter', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: ['a', 'b'] } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid slug parameter' })
    expect(listOrganizationsForProfile).not.toHaveBeenCalled()
  })
})
