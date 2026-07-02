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
  const { data, error } = await executePlatformQuery<PlatformProfileRow>({
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
      )
      select * from new_profile
    `,
    parameters: [input.gotrueId, username, input.email],
  })
  if (error) throw error
  if (!data?.[0]) throw new Error('profile creation returned no row')
  return data[0]
}
