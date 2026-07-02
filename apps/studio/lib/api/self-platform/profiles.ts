// [self-platform] platform.profiles data access + ProfileResponse mapping.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

export type PlatformProfileRow = {
  id: number
  gotrue_id: string
  username: string
  primary_email: string
  first_name: string | null
  last_name: string | null
}

type ProfileResponse = components['schemas']['ProfileResponse']

export function toProfileResponse(row: PlatformProfileRow): ProfileResponse {
  return {
    id: row.id,
    gotrue_id: row.gotrue_id,
    // No auth0 legacy ids on self-platform; prefix keeps GitHub-avatar
    // detection (auth0_id.startsWith('github')) inert.
    auth0_id: `email|${row.gotrue_id}`,
    username: row.username,
    primary_email: row.primary_email,
    first_name: row.first_name,
    last_name: row.last_name,
    mobile: null,
    is_alpha_user: false,
    is_sso_user: false,
    free_project_limit: 10,
    disabled_features: [],
  }
}

export async function getProfileByGotrueId(gotrueId: string): Promise<PlatformProfileRow | null> {
  const { data, error } = await executePlatformQuery<PlatformProfileRow>({
    query: `
      select id, gotrue_id, username, primary_email, first_name, last_name
      from platform.profiles
      where gotrue_id = $1
    `,
    parameters: [gotrueId],
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function createProfileWithDefaultMembership(input: {
  gotrueId: string
  email: string
}): Promise<PlatformProfileRow> {
  const username = input.email.split('@')[0] || input.email
  // [self-platform] I1: `membership` silently inserts zero rows (and errors
  // nowhere) if the `default` org is missing — the CTE chain still succeeds
  // and returns the profile row, leaving the user org-less with no signal.
  // Report membership_created back from the same query (checked against
  // actual row existence, not "was just inserted", so a pre-existing
  // membership from an earlier call still counts as success) and throw if
  // it's false.
  const { data, error } = await executePlatformQuery<
    PlatformProfileRow & { membership_created: boolean }
  >({
    query: `
      with new_profile as (
        insert into platform.profiles (gotrue_id, username, primary_email)
        values ($1, $2, $3)
        on conflict (gotrue_id) do update set updated_at = now()
        returning id, gotrue_id, username, primary_email, first_name, last_name
      ), membership as (
        insert into platform.organization_members (organization_id, profile_id)
        select o.id, p.id
        from platform.organizations o
        cross join new_profile p
        where o.slug = 'default'
        on conflict do nothing
        returning profile_id
      )
      select
        new_profile.*,
        exists (
          select 1
          from platform.organization_members m
          join platform.organizations o on o.id = m.organization_id
          where m.profile_id = new_profile.id and o.slug = 'default'
        ) as membership_created
      from new_profile
    `,
    parameters: [input.gotrueId, username, input.email],
  })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('profile creation returned no row')
  if (!row.membership_created) {
    throw new Error(
      "Failed to create default organization membership: the 'default' organization was not found, or the membership insert failed"
    )
  }
  const { membership_created, ...profile } = row
  return profile
}
