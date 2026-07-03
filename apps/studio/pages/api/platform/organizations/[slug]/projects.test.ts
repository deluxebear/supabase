import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './projects'
import { listOrgProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { getMemberContext } from '@/lib/api/self-platform/members'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/list-user-projects', () => ({
  listOrgProjectsV2: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/members', () => ({ getMemberContext: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const ORG_CTX = {
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getMemberContext).mockResolvedValue(ORG_CTX)
})

describe('GET /platform/organizations/{slug}/projects (self-platform)', () => {
  it('returns the registry-backed paginated project list for a known org', async () => {
    vi.mocked(listOrgProjectsV2).mockResolvedValue({
      pagination: { count: 2, limit: 100, offset: 0 },
      projects: [
        {
          ref: 'proj-a',
          organization_slug: 'acme',
          is_branch: false,
          preview_branch_refs: [],
          databases: [{ identifier: 'proj-a', type: 'PRIMARY' }],
        },
        {
          ref: 'proj-b',
          organization_slug: 'acme',
          is_branch: false,
          preview_branch_refs: [],
          databases: [{ identifier: 'proj-b', type: 'PRIMARY' }],
        },
      ],
    } as any)
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'acme' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(getMemberContext).toHaveBeenCalledWith('g-1')
    expect(listOrgProjectsV2).toHaveBeenCalledWith(ORG_CTX, 'acme', 100, 0)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(body.projects).toHaveLength(2)
  })

  it('falls back to the single default project when the org registry is empty', async () => {
    vi.mocked(listOrgProjectsV2).mockResolvedValue({
      pagination: { count: 1, limit: 100, offset: 0 },
      projects: [
        {
          ref: 'default',
          organization_slug: 'default',
          is_branch: false,
          preview_branch_refs: [],
          databases: [{ identifier: 'default', type: 'PRIMARY' }],
        },
      ],
    } as any)
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.pagination).toEqual({ count: 1, limit: expect.any(Number), offset: 0 })
    expect(body.projects[0]).toMatchObject({
      ref: 'default',
      organization_slug: 'default',
      is_branch: false,
      preview_branch_refs: [],
      databases: [{ identifier: 'default', type: 'PRIMARY' }],
    })
  })

  it('returns 404 for an unknown org slug', async () => {
    vi.mocked(listOrgProjectsV2).mockResolvedValue(null)
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'nope' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Organization not found' })
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
    expect(listOrgProjectsV2).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid limit parameter', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'acme', limit: 'abc' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid pagination parameters' })
    expect(listOrgProjectsV2).not.toHaveBeenCalled()
  })

  it('returns 401 without token claims, and does not call listOrgProjectsV2', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'acme' } })
    await handler(req as any, res as any, undefined)
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData()).toEqual({ message: 'Unauthorized: missing token claims' })
    expect(getMemberContext).not.toHaveBeenCalled()
    expect(listOrgProjectsV2).not.toHaveBeenCalled()
  })

  it('passes through valid limit/offset query params', async () => {
    vi.mocked(listOrgProjectsV2).mockResolvedValue({
      pagination: { count: 1, limit: 1, offset: 1 },
      projects: [],
    } as any)
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'acme', limit: '1', offset: '1' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(listOrgProjectsV2).toHaveBeenCalledWith(ORG_CTX, 'acme', 1, 1)
    expect(res._getStatusCode()).toBe(200)
  })

  it('clamps limit above 1000 but leaves offset above 1000 unclamped', async () => {
    vi.mocked(listOrgProjectsV2).mockResolvedValue({
      pagination: { count: 0, limit: 1000, offset: 1500 },
      projects: [],
    } as any)
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'acme', limit: '5000', offset: '1500' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(listOrgProjectsV2).toHaveBeenCalledWith(ORG_CTX, 'acme', 1000, 1500)
    expect(res._getStatusCode()).toBe(200)
  })
})
