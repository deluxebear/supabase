import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import { getMemberContext, getMemberInOrg, isOrgScopedRole, listMembers } from './members'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const GOTRUE_ID = '11111111-2222-3333-4444-555555555555'

describe('getMemberContext', () => {
  beforeEach(() => {
    vi.mocked(executePlatformQuery).mockReset()
  })

  it('parameterizes the gotrue id and never inlines it', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await getMemberContext(GOTRUE_ID)
    const call = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(call.parameters).toEqual([GOTRUE_ID])
    expect(call.query).not.toContain(GOTRUE_ID)
    expect(call.query).toContain('platform.member_roles')
    expect(call.query).toContain('platform.role_projects')
  })

  it('folds flat rows into roles with project lists', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        // org-scoped Owner (no projects)
        {
          role_id: 1,
          base_role_id: 1,
          base_role_name: 'Owner',
          role_name: 'Owner',
          org_id: 1,
          org_slug: 'default',
          project_id: null,
          project_ref: null,
        },
        // derived Developer role scoped to two projects
        {
          role_id: 5,
          base_role_id: 3,
          base_role_name: 'Developer',
          role_name: 'Developer_projects',
          org_id: 1,
          org_slug: 'default',
          project_id: 10,
          project_ref: 'proj-b',
        },
        {
          role_id: 5,
          base_role_id: 3,
          base_role_name: 'Developer',
          role_name: 'Developer_projects',
          org_id: 1,
          org_slug: 'default',
          project_id: 11,
          project_ref: 'proj-c',
        },
      ],
      error: undefined,
    })
    const ctx = await getMemberContext(GOTRUE_ID)
    expect(ctx.gotrueId).toBe(GOTRUE_ID)
    expect(ctx.roles).toEqual([
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
      {
        id: 5,
        baseRoleId: 3,
        baseRoleName: 'Developer',
        name: 'Developer_projects',
        orgId: 1,
        orgSlug: 'default',
        projectRefs: ['proj-b', 'proj-c'],
        projectIds: [10, 11],
      },
    ])
  })

  it('returns zero roles for an unknown member', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    const ctx = await getMemberContext(GOTRUE_ID)
    expect(ctx.roles).toEqual([])
  })

  it('degrades to zero roles when member_roles is missing (pre-M3 platform-db)', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('relation "platform.member_roles" does not exist'),
    })
    const ctx = await getMemberContext(GOTRUE_ID)
    expect(ctx.roles).toEqual([])
  })

  it('rethrows other database errors', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('connection refused'),
    })
    await expect(getMemberContext(GOTRUE_ID)).rejects.toThrow('connection refused')
  })
})

describe('isOrgScopedRole', () => {
  it('is true only when the role is its own base (id === baseRoleId)', () => {
    expect(isOrgScopedRole({ id: 1, baseRoleId: 1 })).toBe(true)
    expect(isOrgScopedRole({ id: 7, baseRoleId: 3 })).toBe(false)
  })
})

describe('listMembers', () => {
  beforeEach(() => {
    vi.mocked(executePlatformQuery).mockReset()
  })

  it('parameterizes orgId, reads verified mfa factors, scopes role_ids to the org', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          gotrue_id: GOTRUE_ID,
          username: 'admin',
          primary_email: 'admin@internal.test',
          mfa_enabled: true,
          role_ids: [1],
        },
      ],
      error: undefined,
    })
    const rows = await listMembers(1)
    const call = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(call.parameters).toEqual([1])
    expect(call.query).toContain('auth.mfa_factors')
    expect(call.query).toContain("status = 'verified'")
    expect(call.query).toContain('r.organization_id = om.organization_id')
    expect(rows).toEqual([
      {
        gotrue_id: GOTRUE_ID,
        username: 'admin',
        primary_email: 'admin@internal.test',
        mfa_enabled: true,
        role_ids: [1],
      },
    ])
  })

  it('propagates query errors (fail closed, no fabricated rows)', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('boom'),
    })
    await expect(listMembers(1)).rejects.toThrow('boom')
  })
})

describe('getMemberInOrg', () => {
  beforeEach(() => {
    vi.mocked(executePlatformQuery).mockReset()
  })

  it('returns null when the gotrue id has no membership row in the org', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await getMemberInOrg(1, GOTRUE_ID)).toBeNull()
    const call = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(call.parameters).toEqual([1, GOTRUE_ID])
  })

  it('returns profile id and org-scoped role ids', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ profile_id: 42, gotrue_id: GOTRUE_ID, role_ids: [1, 5] }],
      error: undefined,
    })
    expect(await getMemberInOrg(1, GOTRUE_ID)).toEqual({
      profile_id: 42,
      gotrue_id: GOTRUE_ID,
      role_ids: [1, 5],
    })
  })
})
