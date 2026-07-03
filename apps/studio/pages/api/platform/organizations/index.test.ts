import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { listOrganizationsForProfile } from '@/lib/api/self-platform/organizations'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/organizations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listOrganizationsForProfile: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/members', () => ({ getMemberContext: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const ROW = { id: 1, slug: 'default', name: 'Default Organization' }

const roleOf = (over: object) => ({
  id: 1,
  baseRoleId: 1,
  baseRoleName: 'Owner',
  name: 'Owner',
  orgId: 1,
  orgSlug: 'default',
  projectRefs: [],
  projectIds: [],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /platform/organizations (self-platform)', () => {
  it('marks is_owner true for an org-scoped Owner base role', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([ROW])
    vi.mocked(getMemberContext).mockResolvedValue({ gotrueId: 'g-1', roles: [roleOf({})] })
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(listOrganizationsForProfile).toHaveBeenCalledWith('g-1')
    expect(getMemberContext).toHaveBeenCalledWith('g-1')
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: 1, slug: 'default', name: 'Default Organization' })
    expect(body[0].is_owner).toBe(true)
  })

  it('lists a zero-role member org with is_owner false', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([ROW])
    vi.mocked(getMemberContext).mockResolvedValue({ gotrueId: 'g-2', roles: [] })
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, claimsOf('g-2'))
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body[0]).toMatchObject({ id: 1, slug: 'default' })
    expect(body[0].is_owner).toBe(false)
  })

  it('does not set is_owner for a derived Owner-based role scoped to a project', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([ROW])
    vi.mocked(getMemberContext).mockResolvedValue({
      gotrueId: 'g-3',
      roles: [
        roleOf({
          id: 9,
          name: 'Owner_projects',
          projectRefs: ['proj-a'],
          projectIds: [10],
        }),
      ],
    })
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, claimsOf('g-3'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()[0].is_owner).toBe(false)
  })

  it('returns 401 without token claims and never queries memberships', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, undefined)
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData()).toEqual({ message: 'Unauthorized: missing token claims' })
    expect(listOrganizationsForProfile).not.toHaveBeenCalled()
    expect(getMemberContext).not.toHaveBeenCalled()
  })

  it('returns 405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req as any, res as any, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
  })
})
