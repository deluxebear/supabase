// [self-platform] platform.invitations data layer (M3.2). All queries are
// $n-parameterized through pg-meta (executePlatformQuery).
//
// SNAPSHOT SAFETY (M1 I1-BUG lesson): accept is ONE atomic multi-CTE
// statement. The `claimed` CTE is the sole gate — it consumes the invitation
// (accepted_at is null and not expired) and every downstream write hangs off
// it, so a raced/expired token writes NOTHING and the final
// `select count(*) from claimed` reports false. The member_roles insert is
// anchored on the PRE-existing organization_members row (first-login boot
// creates the default-org membership before accept runs — single-org
// assumption, spec §13); the belt-and-braces membership insert in the same
// statement is invisible to that same-snapshot anchor subquery, which is why
// the anchor matches the boot row, not the just-inserted one.
import { executePlatformQuery } from './db'

export type InvitationTokenRow = {
  id: number
  invited_email: string
  role_id: number
  role_scoped_projects: string[] | null
  expires_at: string
  accepted_at: string | null
}

export async function insertInvitation(input: {
  orgId: number
  invitedEmail: string
  roleId: number
  roleScopedProjects: string[] | null
  requireSso: boolean
  invitedById: number
}): Promise<{ id: number; token: string } | null> {
  const { data, error } = await executePlatformQuery<{ id: number; token: string }>({
    // No expires_at column here on purpose: the 24h/UI-isInviteExpired contract
    // lives in ONE place, the migration default.
    query: `
      insert into platform.invitations
        (organization_id, invited_email, role_id, role_scoped_projects, require_sso, invited_by)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (organization_id, invited_email) where accepted_at is null do nothing
      returning id, token
    `,
    parameters: [
      input.orgId,
      input.invitedEmail,
      input.roleId,
      input.roleScopedProjects,
      input.requireSso,
      input.invitedById,
    ],
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function deleteInvitationById(orgId: number, id: number): Promise<void> {
  const { error } = await executePlatformQuery({
    query: 'delete from platform.invitations where organization_id = $1 and id = $2',
    parameters: [orgId, id],
  })
  if (error) throw error
}

export async function getPendingInvitationById(
  orgId: number,
  id: number
): Promise<{ id: number; role_id: number } | null> {
  const { data, error } = await executePlatformQuery<{ id: number; role_id: number }>({
    query: `
      select id, role_id from platform.invitations
      where organization_id = $1 and id = $2 and accepted_at is null
    `,
    parameters: [orgId, id],
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function listPendingInvitations(
  orgId: number
): Promise<{ id: number; invited_at: string; invited_email: string; role_id: number }[]> {
  const { data, error } = await executePlatformQuery<{
    id: number
    invited_at: string
    invited_email: string
    role_id: number
  }>({
    query: `
      select id, invited_at, invited_email, role_id
      from platform.invitations
      where organization_id = $1 and accepted_at is null
      order by id
    `,
    parameters: [orgId],
  })
  if (error) throw error
  return data ?? []
}

export async function getInvitationByToken(
  orgId: number,
  token: string
): Promise<InvitationTokenRow | null> {
  const { data, error } = await executePlatformQuery<InvitationTokenRow>({
    query: `
      select id, invited_email, role_id, role_scoped_projects, expires_at, accepted_at
      from platform.invitations
      where organization_id = $1 and token = $2
    `,
    parameters: [orgId, token],
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function getExistingMemberEmails(orgId: number, emails: string[]): Promise<string[]> {
  const lowered = emails.map((e) => e.toLowerCase())
  const { data, error } = await executePlatformQuery<{ email: string }>({
    query: `
      select lower(pr.primary_email) as email
      from platform.organization_members om
      join platform.profiles pr on pr.id = om.profile_id
      where om.organization_id = $1 and lower(pr.primary_email) = any($2)
    `,
    parameters: [orgId, lowered],
  })
  if (error) throw error
  return (data ?? []).map((r) => r.email)
}

export async function acceptInvitationOrgWide(
  token: string,
  orgId: number,
  profileId: number
): Promise<boolean> {
  const { data, error } = await executePlatformQuery<{ claimed_count: number }>({
    query: `
      with claimed as (
        update platform.invitations
        set accepted_at = now()
        where token = $1 and organization_id = $2
          and accepted_at is null and expires_at > now()
        returning role_id
      ),
      membership as (
        insert into platform.organization_members (organization_id, profile_id)
        select $2, $3 from claimed
        on conflict do nothing
      ),
      grant_role as (
        insert into platform.member_roles (profile_id, role_id)
        select $3, claimed.role_id from claimed
        where exists (
          select 1 from platform.organization_members om
          where om.organization_id = $2 and om.profile_id = $3
        )
        on conflict do nothing
      )
      select count(*)::int as claimed_count from claimed
    `,
    parameters: [token, orgId, profileId],
  })
  if (error) throw error
  return (data?.[0]?.claimed_count ?? 0) > 0
}

export async function acceptInvitationScoped(
  token: string,
  orgId: number,
  profileId: number,
  projectIds: number[]
): Promise<boolean> {
  const { data, error } = await executePlatformQuery<{ claimed_count: number }>({
    query: `
      with claimed as (
        update platform.invitations
        set accepted_at = now()
        where token = $1 and organization_id = $2
          and accepted_at is null and expires_at > now()
        returning role_id
      ),
      membership as (
        insert into platform.organization_members (organization_id, profile_id)
        select $2, $3 from claimed
        on conflict do nothing
      ),
      new_role as (
        insert into platform.roles (organization_id, base_role_id, name, description)
        select $2, br.id, br.name || '_scoped_' || gen_random_uuid(), null
        from claimed
        join platform.roles br
          on br.id = claimed.role_id and br.organization_id = $2 and br.base_role_id = br.id
        returning id
      ),
      link_projects as (
        insert into platform.role_projects (role_id, project_id)
        select new_role.id, pid from new_role, unnest($4::bigint[]) as pid
      ),
      grant_role as (
        insert into platform.member_roles (profile_id, role_id)
        select $3, new_role.id from new_role
        where exists (
          select 1 from platform.organization_members om
          where om.organization_id = $2 and om.profile_id = $3
        )
      )
      select count(*)::int as claimed_count from claimed
    `,
    parameters: [token, orgId, profileId, projectIds],
  })
  if (error) throw error
  return (data?.[0]?.claimed_count ?? 0) > 0
}
