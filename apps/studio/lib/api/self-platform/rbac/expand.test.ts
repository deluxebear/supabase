import type { components } from 'api-types'
import { describe, expect, it } from 'vitest'

import type { MemberContext, MemberRole } from '../members'
import { effectiveBaseRoleName, expandPermissions } from './expand'
import { BASE_ROLE_ORDER, ROLE_MATRIX } from './matrix'
import { FIXED_ROLE_ORDER } from '@/data/organization-members/organization-roles-query'
import { doPermissionsCheck } from '@/lib/permissions-check'

type AccessControlPermission = components['schemas']['AccessControlPermission']

const role = (over: Partial<MemberRole>): MemberRole => ({
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
const ctxOf = (...roles: MemberRole[]): MemberContext => ({ gotrueId: 'g-1', roles })

const OWNER = ctxOf(role({}))
const ADMIN = ctxOf(
  role({ id: 2, baseRoleId: 2, baseRoleName: 'Administrator', name: 'Administrator' })
)
const DEV = ctxOf(role({ id: 3, baseRoleId: 3, baseRoleName: 'Developer', name: 'Developer' }))
const READONLY = ctxOf(role({ id: 4, baseRoleId: 4, baseRoleName: 'Read-only', name: 'Read-only' }))
const DERIVED_DEV = ctxOf(
  role({
    id: 5,
    baseRoleId: 3,
    baseRoleName: 'Developer',
    name: 'Developer_scoped',
    projectRefs: ['proj-b'],
    projectIds: [10],
  })
)

const can = (
  ctx: MemberContext,
  action: string,
  resource: string,
  opts?: { ref?: string; data?: object }
) => doPermissionsCheck(expandPermissions(ctx), action, resource, opts?.data, 'default', opts?.ref)

describe('matrix + expandPermissions', () => {
  it('role names stay aligned with the frontend FIXED_ROLE_ORDER', () => {
    expect([...BASE_ROLE_ORDER]).toEqual(FIXED_ROLE_ORDER)
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual([...FIXED_ROLE_ORDER].sort())
  })

  it('expansion output satisfies the AccessControlPermission contract', () => {
    const grants: AccessControlPermission[] = expandPermissions(OWNER)
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) {
      expect(g.organization_slug).toBe('default')
      expect(g.organization_id).toBe(1)
      expect(g.project_refs).toEqual([])
      expect(g.project_ids).toEqual([])
    }
  })

  it('zero roles expand to an empty grant list', () => {
    expect(expandPermissions(ctxOf())).toEqual([])
  })

  it('unknown base role names grant nothing (fail closed)', () => {
    expect(expandPermissions(ctxOf(role({ baseRoleName: 'Superuser' })))).toEqual([])
  })

  it('Owner can do everything, including granting Owner', () => {
    expect(can(OWNER, 'secrets:Read', 'projects')).toBe(true)
    expect(can(OWNER, 'write:Update', 'organizations')).toBe(true)
    expect(can(OWNER, 'write:Create', 'user_invites', { data: { resource: { role_id: 1 } } })).toBe(
      true
    )
  })

  it('Administrator: everything except org writes and granting/revoking Owner', () => {
    expect(can(ADMIN, 'secrets:Read', 'projects')).toBe(true)
    expect(can(ADMIN, 'write:Update', 'organizations')).toBe(false)
    expect(can(ADMIN, 'write:Create', 'user_invites', { data: { resource: { role_id: 1 } } })).toBe(
      false
    )
    expect(can(ADMIN, 'write:Create', 'user_invites', { data: { resource: { role_id: 3 } } })).toBe(
      true
    )
    expect(
      can(ADMIN, 'write:Delete', 'auth.subject_roles', { data: { resource: { role_id: 1 } } })
    ).toBe(false)
  })

  it('Developer: content read/write, user_content writes, NO credentials/control-plane writes', () => {
    expect(can(DEV, 'tenant:Sql:Admin:Write', 'tables')).toBe(true)
    expect(can(DEV, 'auth:Execute', 'projects')).toBe(true)
    expect(can(DEV, 'storage:Admin:Write', 'projects')).toBe(true)
    expect(can(DEV, 'write:Create', 'user_content')).toBe(true)
    expect(can(DEV, 'secrets:Read', 'projects')).toBe(false)
    expect(can(DEV, 'write:Create', 'user_invites', { data: { resource: { role_id: 4 } } })).toBe(
      false
    )
    expect(can(DEV, 'analytics:Admin:Write', 'projects')).toBe(false)
  })

  it('Read-only: reads yes, writes no', () => {
    expect(can(READONLY, 'read:Read', 'projects')).toBe(true)
    expect(can(READONLY, 'tenant:Sql:Query', 'projects')).toBe(true)
    expect(can(READONLY, 'storage:Admin:Read', 'projects')).toBe(true)
    expect(can(READONLY, 'tenant:Sql:Admin:Write', 'tables')).toBe(false)
    expect(can(READONLY, 'storage:Write', 'projects')).toBe(false)
    expect(can(READONLY, 'write:Create', 'user_content')).toBe(false)
  })

  it('derived roles carry their project scope and do not leak to other refs', () => {
    const grants = expandPermissions(DERIVED_DEV)
    for (const g of grants) {
      expect(g.project_refs).toEqual(['proj-b'])
      expect(g.project_ids).toEqual([10])
    }
    expect(can(DERIVED_DEV, 'tenant:Sql:Query', 'projects', { ref: 'proj-b' })).toBe(true)
    expect(can(DERIVED_DEV, 'tenant:Sql:Query', 'projects', { ref: 'default' })).toBe(false)
  })
})

describe('effectiveBaseRoleName', () => {
  it('picks the strongest applicable role for a ref', () => {
    const both = ctxOf(
      role({ id: 4, baseRoleId: 4, baseRoleName: 'Read-only', name: 'Read-only' }),
      role({
        id: 5,
        baseRoleId: 3,
        baseRoleName: 'Developer',
        name: 'Developer_scoped',
        projectRefs: ['proj-b'],
        projectIds: [10],
      })
    )
    expect(effectiveBaseRoleName(both, 'proj-b')).toBe('Developer')
    expect(effectiveBaseRoleName(both, 'default')).toBe('Read-only')
    expect(effectiveBaseRoleName(READONLY, 'default')).toBe('Read-only')
    expect(effectiveBaseRoleName(ctxOf(), 'default')).toBeNull()
  })
})

describe('I1 guard: empty derived role grants nothing (M3.1)', () => {
  const EMPTY_DERIVED_OWNER = ctxOf(
    role({ id: 9, baseRoleId: 1, baseRoleName: 'Owner', name: 'Owner-scoped-empty' })
    // projectRefs/projectIds 留空 —— 运维手误场景
  )

  it('expandPermissions skips an empty derived role entirely', () => {
    expect(expandPermissions(EMPTY_DERIVED_OWNER)).toEqual([])
  })

  it('effectiveBaseRoleName does not apply an empty derived role to any ref', () => {
    expect(effectiveBaseRoleName(EMPTY_DERIVED_OWNER, 'default')).toBeNull()
  })

  it('org-scoped roles are unaffected (regression)', () => {
    const OWNER_CTX = ctxOf(role({}))
    expect(expandPermissions(OWNER_CTX).length).toBeGreaterThan(0)
    expect(effectiveBaseRoleName(OWNER_CTX, 'default')).toBe('Owner')
  })
})
