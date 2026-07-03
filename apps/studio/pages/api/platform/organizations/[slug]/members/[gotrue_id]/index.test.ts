import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { getMemberInOrg } from '@/lib/api/self-platform/members'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  assignRoleToMember,
  createDerivedRoleWithAssignment,
  getOrgProjectIdsByRefs,
  getRoleInOrg,
} from '@/lib/api/self-platform/roles'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/members', () => ({ getMemberInOrg: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  guardOrgRoute: vi.fn(),
  checkPermission: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/roles', () => ({
  assignRoleToMember: vi.fn(),
  createDerivedRoleWithAssignment: vi.fn(),
  getOrgProjectIdsByRefs: vi.fn(),
  getRoleInOrg: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload
const ORG = { orgId: 1, orgSlug: 'default' }
const TARGET = { profile_id: 42, gotrue_id: 'g-t', role_ids: [4] }

const patchReq = (body: object, query: object = { slug: 'default', gotrue_id: 'g-t' }) =>
  createMocks({ method: 'PATCH', query, body, headers: { Version: '2' } })

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset().mockResolvedValue(ORG)
  vi.mocked(getMemberInOrg).mockReset().mockResolvedValue(TARGET)
  vi.mocked(getRoleInOrg)
    .mockReset()
    .mockResolvedValue({ id: 3, base_role_id: 3, name: 'Developer' })
  vi.mocked(getOrgProjectIdsByRefs).mockReset()
  vi.mocked(assignRoleToMember).mockReset()
  vi.mocked(createDerivedRoleWithAssignment).mockReset()
})

describe('PATCH /platform/organizations/{slug}/members/{gotrue_id} (self-platform)', () => {
  it('org-wide assign: guard carries condition data with the body role_id', async () => {
    const { req, res } = patchReq({ role_id: 3 })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'write:Create',
      resource: 'auth.subject_roles',
      data: { resource: { role_id: 3 } },
    })
    expect(assignRoleToMember).toHaveBeenCalledWith(42, 3)
    expect(createDerivedRoleWithAssignment).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(200)
  })

  it('scoped assign: creates a derived role from validated refs', async () => {
    vi.mocked(getOrgProjectIdsByRefs).mockResolvedValue(
      new Map([
        ['proj-b', 10],
        ['default', 11],
      ])
    )
    const { req, res } = patchReq({ role_id: 3, role_scoped_projects: ['proj-b', 'default'] })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(getOrgProjectIdsByRefs).toHaveBeenCalledWith(1, ['proj-b', 'default'])
    expect(createDerivedRoleWithAssignment).toHaveBeenCalledWith({
      orgId: 1,
      baseRoleId: 3,
      profileId: 42,
      projectIds: [10, 11],
    })
    expect(assignRoleToMember).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(200)
  })

  it('HARD: empty role_scoped_projects is 400 and never reaches the data layer', async () => {
    const { req, res } = patchReq({ role_id: 3, role_scoped_projects: [] })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({
      message: 'role_scoped_projects must be a non-empty list of project refs',
    })
    expect(guardOrgRoute).not.toHaveBeenCalled()
    expect(createDerivedRoleWithAssignment).not.toHaveBeenCalled()
  })

  it('400 for unknown refs, listing the misses', async () => {
    vi.mocked(getOrgProjectIdsByRefs).mockResolvedValue(new Map([['proj-b', 10]]))
    const { req, res } = patchReq({ role_id: 3, role_scoped_projects: ['proj-b', 'ghost'] })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Unknown project refs: ghost' })
    expect(createDerivedRoleWithAssignment).not.toHaveBeenCalled()
  })

  it('400 for a non-integer role_id (before any query)', async () => {
    const { req, res } = patchReq({ role_id: 'one' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid role_id' })
    expect(guardOrgRoute).not.toHaveBeenCalled()
  })

  it('400 when role_id is not an org-scoped base role of this org', async () => {
    vi.mocked(getRoleInOrg).mockResolvedValue({
      id: 7,
      base_role_id: 3,
      name: 'Developer-scoped-x',
    })
    const { req, res } = patchReq({ role_id: 7 })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'role_id must be an org-scoped base role' })
    expect(assignRoleToMember).not.toHaveBeenCalled()
  })

  it('404 when the target is not a member of the org', async () => {
    vi.mocked(getMemberInOrg).mockResolvedValue(null)
    const { req, res } = patchReq({ role_id: 3 })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Member not found' })
  })

  it('guard deny short-circuits before target lookup', async () => {
    vi.mocked(guardOrgRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return null
    })
    const { req, res } = patchReq({ role_id: 1 })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(403)
    expect(getMemberInOrg).not.toHaveBeenCalled()
  })

  it('405 for unsupported methods (GET)', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'default', gotrue_id: 'g-t' },
    })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(405)
  })

  it('400 for array path params', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { slug: 'default', gotrue_id: ['a', 'b'] },
      body: { role_id: 3 },
    })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid path parameter' })
  })
})
