import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from '../../../../../../../../../pages/api/platform/organizations/[slug]/members/[gotrue_id]/roles/[role_id]'
import { getMemberInOrg } from '@/lib/api/self-platform/members'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  countOtherOrgScopedOwnerHolders,
  getOrgProjectIdsByRefs,
  getRoleInOrg,
  replaceRoleProjects,
  unassignRoleWithGc,
} from '@/lib/api/self-platform/roles'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/members', () => ({ getMemberInOrg: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/roles', () => ({
  countOtherOrgScopedOwnerHolders: vi.fn(),
  getOrgProjectIdsByRefs: vi.fn(),
  getRoleInOrg: vi.fn(),
  replaceRoleProjects: vi.fn(),
  unassignRoleWithGc: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload
const ORG = { orgId: 1, orgSlug: 'default' }
const DERIVED = { id: 7, base_role_id: 3, name: 'Developer-scoped-x' }

const reqOf = (method: 'PUT' | 'DELETE', body?: object, roleId = '7') =>
  createMocks({
    method,
    query: { slug: 'default', gotrue_id: 'g-t', role_id: roleId },
    ...(body === undefined ? {} : { body }),
  })

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset().mockResolvedValue(ORG)
  vi.mocked(getMemberInOrg)
    .mockReset()
    .mockResolvedValue({ profile_id: 42, gotrue_id: 'g-t', role_ids: [7] })
  vi.mocked(getRoleInOrg).mockReset().mockResolvedValue(DERIVED)
  vi.mocked(getOrgProjectIdsByRefs).mockReset()
  vi.mocked(replaceRoleProjects).mockReset()
  vi.mocked(unassignRoleWithGc).mockReset().mockResolvedValue(1)
  vi.mocked(countOtherOrgScopedOwnerHolders).mockReset().mockResolvedValue(1)
})

describe('PUT .../members/{gotrue_id}/roles/{role_id} (self-platform)', () => {
  it('replaces the derived role project set with validated refs, condition data pinned', async () => {
    vi.mocked(getOrgProjectIdsByRefs).mockResolvedValue(new Map([['proj-b', 10]]))
    const { req, res } = reqOf('PUT', {
      name: 'Developer-scoped-x',
      role_scoped_projects: ['proj-b'],
    })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Create',
      resource: 'auth.subject_roles',
      data: { resource: { role_id: 7 } },
    })
    expect(replaceRoleProjects).toHaveBeenCalledWith(7, [10])
    expect(res._getStatusCode()).toBe(200)
  })

  it('dedupes duplicate refs before validation and mapping', async () => {
    vi.mocked(getOrgProjectIdsByRefs).mockResolvedValue(new Map([['proj-b', 10]]))
    const { req, res } = reqOf('PUT', {
      name: 'Developer-scoped-x',
      role_scoped_projects: ['proj-b', 'proj-b'],
    })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(getOrgProjectIdsByRefs).toHaveBeenCalledWith(1, ['proj-b'])
    expect(replaceRoleProjects).toHaveBeenCalledWith(7, [10])
    expect(res._getStatusCode()).toBe(200)
  })

  it('HARD: empty role_scoped_projects is 400 and never reaches the data layer', async () => {
    const { req, res } = reqOf('PUT', { name: 'x', role_scoped_projects: [] })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({
      message: 'role_scoped_projects must be a non-empty list of project refs',
    })
    expect(replaceRoleProjects).not.toHaveBeenCalled()
  })

  it('400 when targeting an org-scoped base role', async () => {
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 3, base_role_id: 3, name: 'Developer' })
    const { req, res } = reqOf('PUT', { name: 'Developer', role_scoped_projects: ['proj-b'] }, '3')
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Only project-scoped roles can be updated' })
  })

  it('404 when the target member does not hold the role', async () => {
    vi.mocked(getMemberInOrg).mockResolvedValue({ profile_id: 42, gotrue_id: 'g-t', role_ids: [3] })
    const { req, res } = reqOf('PUT', { name: 'x', role_scoped_projects: ['proj-b'] })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Member role not found' })
  })
})

describe('DELETE .../members/{gotrue_id}/roles/{role_id} (self-platform)', () => {
  it('unassigns with GC, condition data pinned to the PATH role id', async () => {
    const { req, res } = reqOf('DELETE')
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Delete',
      resource: 'auth.subject_roles',
      data: { resource: { role_id: 7 } },
    })
    expect(unassignRoleWithGc).toHaveBeenCalledWith(42, 7)
    expect(res._getStatusCode()).toBe(200)
  })

  it('400 blocks removing the LAST org-scoped Owner', async () => {
    vi.mocked(getMemberInOrg).mockResolvedValue({ profile_id: 42, gotrue_id: 'g-t', role_ids: [1] })
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 1, base_role_id: 1, name: 'Owner' })
    vi.mocked(countOtherOrgScopedOwnerHolders).mockResolvedValue(0)
    const { req, res } = reqOf('DELETE', undefined, '1')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({
      message: 'Cannot remove the last Owner of the organization',
    })
    expect(unassignRoleWithGc).not.toHaveBeenCalled()
  })

  it('allows removing an org-scoped Owner when another Owner remains', async () => {
    vi.mocked(getMemberInOrg).mockResolvedValue({ profile_id: 42, gotrue_id: 'g-t', role_ids: [1] })
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 1, base_role_id: 1, name: 'Owner' })
    vi.mocked(countOtherOrgScopedOwnerHolders).mockResolvedValue(1)
    const { req, res } = reqOf('DELETE', undefined, '1')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(unassignRoleWithGc).toHaveBeenCalledWith(42, 1)
    expect(res._getStatusCode()).toBe(200)
  })

  it('404 for a role id not present in the org', async () => {
    vi.mocked(getRoleInOrg).mockResolvedValue(null)
    vi.mocked(getMemberInOrg).mockResolvedValue({ profile_id: 42, gotrue_id: 'g-t', role_ids: [7] })
    const { req, res } = reqOf('DELETE', undefined, '999')
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Member role not found' })
  })
})

describe('shared plumbing', () => {
  it('405 for POST; 400 for non-integer role_id; 400 for array params', async () => {
    const post = createMocks({
      method: 'POST',
      query: { slug: 'default', gotrue_id: 'g-t', role_id: '7' },
    })
    await handler(post.req as never, post.res as never, claimsOf('g-1'))
    expect(post.res._getStatusCode()).toBe(405)

    const bad = reqOf('DELETE', undefined, 'abc')
    await handler(bad.req as never, bad.res as never, claimsOf('g-1'))
    expect(bad.res._getStatusCode()).toBe(400)
    expect(bad.res._getJSONData()).toEqual({ message: 'Invalid role_id parameter' })

    const arr = createMocks({
      method: 'DELETE',
      query: { slug: ['a'], gotrue_id: 'g-t', role_id: '7' },
    })
    await handler(arr.req as never, arr.res as never, claimsOf('g-1'))
    expect(arr.res._getStatusCode()).toBe(400)
  })
})
