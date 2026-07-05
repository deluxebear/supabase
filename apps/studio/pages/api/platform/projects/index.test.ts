import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { DEFAULT_PROJECT } from '@/lib/constants/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/list-user-projects', () => ({
  listAllProjectsV2: vi.fn(),
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

describe('GET /platform/projects (self-platform)', () => {
  it('returns the registry-backed V2 paginated shape when Version: 2 header present', async () => {
    vi.mocked(listAllProjectsV2).mockResolvedValue({
      pagination: { count: 2, limit: 100, offset: 0 },
      projects: [
        { ref: 'proj-a', organization_slug: 'acme', preview_branch_refs: [] },
        { ref: 'proj-b', organization_slug: 'other', preview_branch_refs: [] },
      ],
    } as any)
    const { req, res } = createMocks({ method: 'GET', headers: { version: '2' } })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(getMemberContext).toHaveBeenCalledWith('g-1')
    expect(listAllProjectsV2).toHaveBeenCalledWith(ORG_CTX, 100, 0)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(body.projects).toHaveLength(2)
    expect(body.projects[0]).toMatchObject({ ref: 'proj-a', organization_slug: 'acme' })
  })

  it('keeps the legacy V1 array without the header, unchanged', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([DEFAULT_PROJECT])
    expect(listAllProjectsV2).not.toHaveBeenCalled()
  })

  it('V1 request without claims still returns 200 [DEFAULT_PROJECT] (claims-independence)', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([DEFAULT_PROJECT])
    expect(getMemberContext).not.toHaveBeenCalled()
    expect(listAllProjectsV2).not.toHaveBeenCalled()
  })

  // M5.0: POST is a real method now — 405 coverage moved to PUT
  it('returns 405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'PUT' })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
  })

  it('returns 400 for an invalid limit parameter', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      headers: { version: '2' },
      query: { limit: 'abc' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid pagination parameters' })
    expect(listAllProjectsV2).not.toHaveBeenCalled()
  })

  it('returns 401 for the V2 path without token claims, and does not call listAllProjectsV2', async () => {
    const { req, res } = createMocks({ method: 'GET', headers: { version: '2' } })
    await handler(req as any, res as any, undefined)
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData()).toEqual({ message: 'Unauthorized: missing token claims' })
    expect(getMemberContext).not.toHaveBeenCalled()
    expect(listAllProjectsV2).not.toHaveBeenCalled()
  })

  it('passes through valid limit/offset query params', async () => {
    vi.mocked(listAllProjectsV2).mockResolvedValue({
      pagination: { count: 1, limit: 1, offset: 1 },
      projects: [],
    } as any)
    const { req, res } = createMocks({
      method: 'GET',
      headers: { version: '2' },
      query: { limit: '1', offset: '1' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(listAllProjectsV2).toHaveBeenCalledWith(ORG_CTX, 1, 1)
    expect(res._getStatusCode()).toBe(200)
  })

  it('clamps limit above 1000 but leaves offset above 1000 unclamped', async () => {
    vi.mocked(listAllProjectsV2).mockResolvedValue({
      pagination: { count: 0, limit: 1000, offset: 1500 },
      projects: [],
    } as any)
    const { req, res } = createMocks({
      method: 'GET',
      headers: { version: '2' },
      query: { limit: '5000', offset: '1500' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(listAllProjectsV2).toHaveBeenCalledWith(ORG_CTX, 1000, 1500)
    expect(res._getStatusCode()).toBe(200)
  })
})
