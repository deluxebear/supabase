// [self-platform] Member role context: which roles a dashboard user holds,
// and which projects each role is scoped to. Single source for the
// permissions endpoint (expand), server-side enforcement (rbac/enforce),
// and list visibility (list-user-projects).
import { executePlatformQuery } from './db'

export type MemberRole = {
  id: number
  baseRoleId: number
  baseRoleName: string
  name: string
  orgId: number
  orgSlug: string
  /** Empty for org-scoped roles; project refs for derived roles. */
  projectRefs: string[]
  projectIds: number[]
}

export type MemberContext = {
  gotrueId: string
  roles: MemberRole[]
}

type MemberRoleRow = {
  role_id: number
  base_role_id: number
  base_role_name: string
  role_name: string
  org_id: number
  org_slug: string
  project_id: number | null
  project_ref: string | null
}

// [self-platform] Pre-M3 platform-db data dirs lack the role tables
// (04-roles.sql applied manually on upgrades). Degrade to ZERO roles —
// fail-closed (users see nothing until the migration is applied), never
// fail-open. Mirrors the missing-column degradation in projects.ts.
const MISSING_MEMBER_ROLES_TABLE = 'relation "platform.member_roles" does not exist'

let warnedMissingRoleTables = false

export async function getMemberContext(gotrueId: string): Promise<MemberContext> {
  const { data, error } = await executePlatformQuery<MemberRoleRow>({
    query: `
      select r.id as role_id, r.base_role_id, br.name as base_role_name,
             r.name as role_name, o.id as org_id, o.slug as org_slug,
             p.id as project_id, p.ref as project_ref
      from platform.profiles pr
      join platform.member_roles mr on mr.profile_id = pr.id
      join platform.roles r on r.id = mr.role_id
      join platform.roles br on br.id = r.base_role_id
      join platform.organizations o on o.id = r.organization_id
      left join platform.role_projects rp on rp.role_id = r.id
      left join platform.projects p on p.id = rp.project_id
      where pr.gotrue_id = $1
      order by r.id, p.id
    `,
    parameters: [gotrueId],
  })
  if (error) {
    if (!error.message.includes(MISSING_MEMBER_ROLES_TABLE)) throw error
    if (!warnedMissingRoleTables) {
      warnedMissingRoleTables = true
      console.warn(
        '[self-platform] platform.member_roles missing (pre-M3 platform-db) — treating every member as having ZERO roles (fail-closed). Run docker/volumes/platform/migrations/04-roles.sql to upgrade.'
      )
    }
    return { gotrueId, roles: [] }
  }

  const byRole = new Map<number, MemberRole>()
  for (const row of data ?? []) {
    let role = byRole.get(row.role_id)
    if (!role) {
      role = {
        id: row.role_id,
        baseRoleId: row.base_role_id,
        baseRoleName: row.base_role_name,
        name: row.role_name,
        orgId: row.org_id,
        orgSlug: row.org_slug,
        projectRefs: [],
        projectIds: [],
      }
      byRole.set(row.role_id, role)
    }
    if (row.project_id !== null && row.project_ref !== null) {
      role.projectIds.push(row.project_id)
      role.projectRefs.push(row.project_ref)
    }
  }
  return { gotrueId, roles: [...byRole.values()] }
}

/** [self-platform] Org-scoped role = a base role pointing at itself. The
 * reliable discriminator for the I1 empty-derived-role guards (M3.1):
 * a DERIVED role with an empty project set must grant NOTHING — do not
 * use `projectRefs.length === 0` as the org-scoped test. */
export function isOrgScopedRole(role: Pick<MemberRole, 'id' | 'baseRoleId'>): boolean {
  return role.id === role.baseRoleId
}

export type MemberListRow = {
  gotrue_id: string
  username: string
  primary_email: string
  mfa_enabled: boolean
  role_ids: number[]
}

// [self-platform] Member list for GET /organizations/{slug}/members.
// mfa_enabled reads GoTrue's own auth.mfa_factors table — platform-auth and
// the platform metadata schema share the platform database
// (docker-compose.platform.yml GOTRUE_DB_DATABASE_URL). role_ids only counts
// roles belonging to THIS org (cross-org isolation).
export async function listMembers(orgId: number): Promise<MemberListRow[]> {
  const { data, error } = await executePlatformQuery<MemberListRow>({
    query: `
      select pr.gotrue_id, pr.username, pr.primary_email,
             exists (
               select 1 from auth.mfa_factors f
               where f.user_id = pr.gotrue_id and f.status = 'verified'
             ) as mfa_enabled,
             coalesce(
               (select array_agg(mr.role_id order by mr.role_id)
                  from platform.member_roles mr
                  join platform.roles r on r.id = mr.role_id
                 where mr.profile_id = pr.id
                   and r.organization_id = om.organization_id),
               '{}'
             ) as role_ids
      from platform.organization_members om
      join platform.profiles pr on pr.id = om.profile_id
      where om.organization_id = $1
      order by pr.id
    `,
    parameters: [orgId],
  })
  if (error) throw error
  return data ?? []
}

export type OrgMemberRow = {
  profile_id: number
  gotrue_id: string
  role_ids: number[]
}

export async function getMemberInOrg(
  orgId: number,
  gotrueId: string
): Promise<OrgMemberRow | null> {
  const { data, error } = await executePlatformQuery<OrgMemberRow>({
    query: `
      select pr.id as profile_id, pr.gotrue_id,
             coalesce(
               (select array_agg(mr.role_id order by mr.role_id)
                  from platform.member_roles mr
                  join platform.roles r on r.id = mr.role_id
                 where mr.profile_id = pr.id
                   and r.organization_id = om.organization_id),
               '{}'
             ) as role_ids
      from platform.organization_members om
      join platform.profiles pr on pr.id = om.profile_id
      where om.organization_id = $1 and pr.gotrue_id = $2
    `,
    parameters: [orgId, gotrueId],
  })
  if (error) throw error
  return data?.[0] ?? null
}
