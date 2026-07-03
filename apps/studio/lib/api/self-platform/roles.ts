// [self-platform] platform.roles data layer (M3.1): V2 dual-layer listing +
// derived (project-scoped) role lifecycle. Derived roles are created
// IMPLICITLY by PATCH member V2 (cloud parity — there is no standalone
// create-role endpoint) and garbage-collected when their last holder
// unassigns. Derived names follow the format "base_role_name_scoped_uuid"
// (underscore-delimited); the UI extracts the base name via split('_')[0].
//
// SNAPSHOT SAFETY (M1 I1-BUG lesson): inside a single multi-CTE statement,
// sub-selects see the PRE-statement snapshot. Two consequences encoded here:
// 1. GC predicates must be written as "does any OTHER profile hold this
//    role" (profile_id <> $n) — a bare `not exists` still sees the row the
//    sibling CTE just deleted and the GC never fires.
// 2. replaceRoleProjects' insert must REFERENCE the clearing CTE so the
//    delete is forced to run first — independent modifying CTEs have no
//    ordering guarantee, and `on conflict do nothing` against not-yet-deleted
//    rows would let the delete then remove refs common to old and new sets.
import { executePlatformQuery } from './db'

export type RoleListItem = {
  id: number
  base_role_id: number
  name: string
  description: string | null
  projects: { name: string; ref: string }[]
}

export type RolesV2 = {
  org_scoped_roles: RoleListItem[]
  project_scoped_roles: RoleListItem[]
}

type RoleRow = {
  id: number
  base_role_id: number
  name: string
  description: string | null
  project_name: string | null
  project_ref: string | null
}

export async function listRolesV2(orgId: number): Promise<RolesV2> {
  const { data, error } = await executePlatformQuery<RoleRow>({
    query: `
      select r.id, r.base_role_id, r.name, r.description,
             p.name as project_name, p.ref as project_ref
      from platform.roles r
      left join platform.role_projects rp on rp.role_id = r.id
      left join platform.projects p on p.id = rp.project_id
      where r.organization_id = $1
      order by r.id, p.id
    `,
    parameters: [orgId],
  })
  if (error) throw error

  const byId = new Map<number, RoleListItem>()
  for (const row of data ?? []) {
    let item = byId.get(row.id)
    if (!item) {
      item = {
        id: row.id,
        base_role_id: row.base_role_id,
        name: row.name,
        description: row.description,
        projects: [],
      }
      byId.set(row.id, item)
    }
    if (row.project_name !== null && row.project_ref !== null) {
      item.projects.push({ name: row.project_name, ref: row.project_ref })
    }
  }
  const all = [...byId.values()]
  return {
    org_scoped_roles: all.filter((r) => r.base_role_id === r.id),
    project_scoped_roles: all.filter((r) => r.base_role_id !== r.id),
  }
}

export type OrgRoleRow = { id: number; base_role_id: number; name: string }

export async function getRoleInOrg(orgId: number, roleId: number): Promise<OrgRoleRow | null> {
  const { data, error } = await executePlatformQuery<OrgRoleRow>({
    query:
      'select id, base_role_id, name from platform.roles where organization_id = $1 and id = $2',
    parameters: [orgId, roleId],
  })
  if (error) throw error
  return data?.[0] ?? null
}

// Ref pre-validation runs as its OWN query, never folded into the insert
// statement (same-statement snapshot pitfalls — see header note).
export async function getOrgProjectIdsByRefs(
  orgId: number,
  refs: string[]
): Promise<Map<string, number>> {
  const { data, error } = await executePlatformQuery<{ id: number; ref: string }>({
    query: 'select id, ref from platform.projects where organization_id = $1 and ref = any($2)',
    parameters: [orgId, refs],
  })
  if (error) throw error
  return new Map((data ?? []).map((row) => [row.ref, row.id]))
}

export async function assignRoleToMember(profileId: number, roleId: number): Promise<void> {
  const { error } = await executePlatformQuery({
    query:
      'insert into platform.member_roles (profile_id, role_id) values ($1, $2) on conflict do nothing',
    parameters: [profileId, roleId],
  })
  if (error) throw error
}

export async function createDerivedRoleWithAssignment(input: {
  orgId: number
  baseRoleId: number
  profileId: number
  projectIds: number[]
}): Promise<void> {
  const { orgId, baseRoleId, profileId, projectIds } = input
  const { data, error } = await executePlatformQuery<{ role_id: number }>({
    query: `
      with new_role as (
        insert into platform.roles (organization_id, base_role_id, name, description)
        select $1, r.id, r.name || '_scoped_' || gen_random_uuid(), null
        from platform.roles r
        where r.id = $2 and r.organization_id = $1 and r.base_role_id = r.id
        returning id
      ),
      link_projects as (
        insert into platform.role_projects (role_id, project_id)
        select new_role.id, pid from new_role, unnest($3::bigint[]) as pid
      )
      insert into platform.member_roles (profile_id, role_id)
      select $4, id from new_role
      returning role_id
    `,
    parameters: [orgId, baseRoleId, projectIds, profileId],
  })
  if (error) throw error
  if ((data ?? []).length !== 1) {
    // base role missing / not org-scoped / wrong org — the route validates
    // first, so reaching this is a server bug or a race; fail loudly.
    throw new Error('Failed to create derived role')
  }
}

export async function replaceRoleProjects(roleId: number, projectIds: number[]): Promise<void> {
  const { error } = await executePlatformQuery({
    query: `
      with cleared as (
        delete from platform.role_projects where role_id = $1 returning 1
      )
      insert into platform.role_projects (role_id, project_id)
      select $1, pid
      from unnest($2::bigint[]) as pid
      where (select count(*) from cleared) >= 0
    `,
    parameters: [roleId, projectIds],
  })
  if (error) throw error
}

export async function unassignRoleWithGc(profileId: number, roleId: number): Promise<number> {
  const { data, error } = await executePlatformQuery<{ role_id: number }>({
    query: `
      with removed as (
        delete from platform.member_roles
        where profile_id = $1 and role_id = $2
        returning role_id
      ),
      gc as (
        delete from platform.roles r
        using removed
        where r.id = removed.role_id
          and r.base_role_id <> r.id
          and not exists (
            select 1 from platform.member_roles mr
            where mr.role_id = r.id and mr.profile_id <> $1
          )
      )
      select role_id from removed
    `,
    parameters: [profileId, roleId],
  })
  if (error) throw error
  return (data ?? []).length
}

export async function removeMemberWithGc(orgId: number, profileId: number): Promise<void> {
  const { error } = await executePlatformQuery({
    query: `
      with removed_roles as (
        delete from platform.member_roles mr
        using platform.roles r
        where mr.profile_id = $2 and r.id = mr.role_id and r.organization_id = $1
        returning mr.role_id
      ),
      gc as (
        delete from platform.roles r
        using removed_roles
        where r.id = removed_roles.role_id
          and r.base_role_id <> r.id
          and not exists (
            select 1 from platform.member_roles mr
            where mr.role_id = r.id and mr.profile_id <> $2
          )
      )
      delete from platform.organization_members
      where organization_id = $1 and profile_id = $2
    `,
    parameters: [orgId, profileId],
  })
  if (error) throw error
}

export async function countOtherOrgScopedOwnerHolders(
  orgId: number,
  excludeProfileId: number
): Promise<number> {
  const { data, error } = await executePlatformQuery<{ count: number }>({
    query: `
      select count(*)::int as count
      from platform.member_roles mr
      join platform.roles r on r.id = mr.role_id
      where r.organization_id = $1
        and r.base_role_id = r.id
        and r.name = 'Owner'
        and mr.profile_id <> $2
    `,
    parameters: [orgId, excludeProfileId],
  })
  if (error) throw error
  return data?.[0]?.count ?? 0
}
