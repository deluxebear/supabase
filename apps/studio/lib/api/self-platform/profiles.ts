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
  // [self-platform] I1: the membership insert is a `where o.slug = 'default'`
  // join — if the seed org is missing, the CTE chain still succeeds and
  // returns the profile row, silently leaving the user org-less. We must
  // fail loudly instead.
  //
  // Note this can NOT be checked by reading back
  // platform.organization_members in the same statement/snapshot as the
  // membership insert: an `exists(select 1 from platform.organization_members
  // ...)` run alongside the insert CTE never observes the row the insert
  // CTE just wrote (base-table reads inside a single statement all see the
  // same snapshot, taken before any of the statement's own writes). That
  // previously made membership_created always false, throwing on every
  // fresh profile creation. Instead we detect the real failure condition —
  // org existence — via a `target_org` CTE, a plain SELECT that's fully
  // visible in the same snapshot, and drive both the membership insert and
  // the check off of it.
  const { data, error } = await executePlatformQuery<PlatformProfileRow & { org_exists: boolean }>({
    query: `
      with target_org as (
        select id from platform.organizations where slug = 'default'
      ), new_profile as (
        insert into platform.profiles (gotrue_id, username, primary_email)
        values ($1, $2, $3)
        on conflict (gotrue_id) do update set updated_at = now()
        returning id, gotrue_id, username, primary_email, first_name, last_name
      ), membership as (
        insert into platform.organization_members (organization_id, profile_id)
        select t.id, p.id
        from target_org t
        cross join new_profile p
        on conflict do nothing
      )
      select
        np.*,
        (select count(*) from target_org) > 0 as org_exists
      from new_profile np
    `,
    parameters: [input.gotrueId, username, input.email],
  })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('profile creation returned no row')
  if (!row.org_exists) {
    throw new Error('default organization is missing; cannot provision membership')
  }
  const { org_exists, ...profile } = row
  return profile
}
