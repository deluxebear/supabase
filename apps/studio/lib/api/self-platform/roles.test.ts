import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  assignRoleToMember,
  countOtherOrgScopedOwnerHolders,
  createDerivedRoleWithAssignment,
  getOrgProjectIdsByRefs,
  getRoleInOrg,
  listRolesV2,
  removeMemberWithGc,
  replaceRoleProjects,
  unassignRoleWithGc,
} from './roles'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const ok = (data: unknown[]) =>
  vi.mocked(executePlatformQuery).mockResolvedValue({ data, error: undefined } as never)
const lastCall = () => vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]

beforeEach(() => {
  vi.mocked(executePlatformQuery).mockReset()
})

describe('listRolesV2', () => {
  it('folds rows and splits org-scoped vs derived by base_role_id self-reference', async () => {
    ok([
      {
        id: 1,
        base_role_id: 1,
        name: 'Owner',
        description: null,
        project_name: null,
        project_ref: null,
      },
      {
        id: 3,
        base_role_id: 3,
        name: 'Developer',
        description: null,
        project_name: null,
        project_ref: null,
      },
      {
        id: 7,
        base_role_id: 3,
        name: 'Developer-scoped-x',
        description: null,
        project_name: 'Project B',
        project_ref: 'proj-b',
      },
      {
        id: 7,
        base_role_id: 3,
        name: 'Developer-scoped-x',
        description: null,
        project_name: 'Default',
        project_ref: 'default',
      },
    ])
    const out = await listRolesV2(1)
    expect(lastCall().parameters).toEqual([1])
    expect(out.org_scoped_roles).toEqual([
      { id: 1, base_role_id: 1, name: 'Owner', description: null, projects: [] },
      { id: 3, base_role_id: 3, name: 'Developer', description: null, projects: [] },
    ])
    expect(out.project_scoped_roles).toEqual([
      {
        id: 7,
        base_role_id: 3,
        name: 'Developer-scoped-x',
        description: null,
        projects: [
          { name: 'Project B', ref: 'proj-b' },
          { name: 'Default', ref: 'default' },
        ],
      },
    ])
  })
})

describe('getOrgProjectIdsByRefs', () => {
  it('parameterizes org + refs array and maps ref -> id', async () => {
    ok([
      { id: 10, ref: 'proj-b' },
      { id: 11, ref: 'default' },
    ])
    const map = await getOrgProjectIdsByRefs(1, ['proj-b', 'default', 'ghost'])
    expect(lastCall().parameters).toEqual([1, ['proj-b', 'default', 'ghost']])
    expect(lastCall().query).toContain('ref = any($2)')
    expect(map.get('proj-b')).toBe(10)
    expect(map.has('ghost')).toBe(false)
  })
})

describe('getRoleInOrg', () => {
  it('returns null for a role outside the org', async () => {
    ok([])
    expect(await getRoleInOrg(1, 99)).toBeNull()
    expect(lastCall().parameters).toEqual([1, 99])
  })
})

describe('assignRoleToMember', () => {
  it('is idempotent via on conflict do nothing', async () => {
    ok([])
    await assignRoleToMember(42, 3)
    expect(lastCall().parameters).toEqual([42, 3])
    expect(lastCall().query).toContain('on conflict do nothing')
  })
})

describe('createDerivedRoleWithAssignment', () => {
  it('inserts role + role_projects + member_roles atomically and validates the base', async () => {
    ok([{ role_id: 7 }])
    await createDerivedRoleWithAssignment({
      orgId: 1,
      baseRoleId: 3,
      profileId: 42,
      projectIds: [10, 11],
    })
    const call = lastCall()
    expect(call.parameters).toEqual([1, 3, [10, 11], 42])
    expect(call.query).toContain('r.base_role_id = r.id') // base 必须是 org-scoped 基础角色
    expect(call.query).toContain('gen_random_uuid()')
    expect(call.query).toContain('platform.role_projects')
    expect(call.query).toContain('platform.member_roles')
    // REGRESSION PIN: UI display depends on underscore-delimited names (split('_')[0])
    expect(call.query).toContain("'_scoped_'")
  })

  it('throws when the base role is invalid (no row inserted)', async () => {
    ok([])
    await expect(
      createDerivedRoleWithAssignment({
        orgId: 1,
        baseRoleId: 999,
        profileId: 42,
        projectIds: [10],
      })
    ).rejects.toThrow('Failed to create derived role')
  })
})

describe('replaceRoleProjects', () => {
  it('forces the clear-CTE to run before the insert (same-statement ordering)', async () => {
    ok([])
    await replaceRoleProjects(7, [10])
    const call = lastCall()
    expect(call.parameters).toEqual([7, [10]])
    // REGRESSION PIN（勿删）：insert 必须引用 cleared CTE 强制先删后插——
    // 独立的 modifying CTE 执行顺序不保证，若 insert 先跑，
    // on conflict do nothing 保留旧行后 delete 再删掉它们 → 交集 refs 丢失。
    expect(call.query).toContain('from cleared')
  })
})

describe('unassignRoleWithGc', () => {
  it('deletes the member_roles row and GCs an orphaned derived role, other-holder form', async () => {
    ok([{ role_id: 7 }])
    const removed = await unassignRoleWithGc(42, 7)
    expect(removed).toBe(1)
    const call = lastCall()
    expect(call.parameters).toEqual([42, 7])
    // REGRESSION PIN（勿删）：GC 判式必须是 "其他持有者"（profile_id <> $1）——
    // 同语句快照下裸 not exists 仍看得见刚删的行，GC 永不触发（M1 I1-BUG 教训）。
    expect(call.query).toContain('mr.profile_id <> $1')
    expect(call.query).toContain('r.base_role_id <> r.id')
  })

  it('returns 0 when the member did not hold the role', async () => {
    ok([])
    expect(await unassignRoleWithGc(42, 999)).toBe(0)
  })
})

describe('removeMemberWithGc', () => {
  it('drops org role links, GCs orphans (other-holder form), removes membership', async () => {
    ok([])
    await removeMemberWithGc(1, 42)
    const call = lastCall()
    expect(call.parameters).toEqual([1, 42])
    expect(call.query).toContain('mr.profile_id <> $2')
    expect(call.query).toContain('platform.organization_members')
  })
})

describe('countOtherOrgScopedOwnerHolders', () => {
  it('counts org-scoped Owner holders excluding the target profile', async () => {
    ok([{ count: 1 }])
    expect(await countOtherOrgScopedOwnerHolders(1, 42)).toBe(1)
    const call = lastCall()
    expect(call.parameters).toEqual([1, 42])
    expect(call.query).toContain("r.name = 'Owner'")
    expect(call.query).toContain('r.base_role_id = r.id')
  })
})
