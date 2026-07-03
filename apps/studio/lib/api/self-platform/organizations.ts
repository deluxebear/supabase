// [self-platform] platform.organizations data access + contract mapping.
// Plan is hard-coded 'enterprise' so plan/entitlement-gated UI stays open
// (spec §4.5); billing fields are nulled — self-platform has no billing.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

export type PlatformOrganizationRow = { id: number; slug: string; name: string }

type OrganizationResponse = components['schemas']['OrganizationResponse']
type OrganizationSlugResponse = components['schemas']['OrganizationSlugResponse']

const ENTERPRISE_PLAN = { id: 'enterprise' as const, name: 'Enterprise' }

export function toOrganizationResponse(
  row: PlatformOrganizationRow,
  isOwner: boolean
): OrganizationResponse {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    billing_email: null,
    billing_partner: null,
    integration_source: null,
    is_owner: isOwner, // [self-platform] M3.0: real Owner-role check (was hardcoded true)
    opt_in_tags: [],
    organization_missing_address: false,
    organization_missing_tax_id: false,
    organization_requires_mfa: false,
    plan: ENTERPRISE_PLAN,
    restriction_data: null,
    restriction_status: null,
    stripe_customer_id: null,
    subscription_id: null,
    usage_billing_enabled: false,
  }
}

export function toOrganizationSlugResponse(row: PlatformOrganizationRow): OrganizationSlugResponse {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    billing_email: null,
    billing_partner: null,
    has_oriole_project: false,
    integration_source: null,
    opt_in_tags: [],
    plan: ENTERPRISE_PLAN,
    restriction_data: null,
    restriction_status: null,
    usage_billing_enabled: false,
  }
}

export async function listOrganizations(): Promise<PlatformOrganizationRow[]> {
  const { data, error } = await executePlatformQuery<PlatformOrganizationRow>({
    query: 'select id, slug, name from platform.organizations order by id',
  })
  if (error) throw error
  return data ?? []
}

export async function getOrganizationBySlug(slug: string): Promise<PlatformOrganizationRow | null> {
  const { data, error } = await executePlatformQuery<PlatformOrganizationRow>({
    query: 'select id, slug, name from platform.organizations where slug = $1',
    parameters: [slug],
  })
  if (error) throw error
  return data?.[0] ?? null
}

// [self-platform] Organizations the profile is a MEMBER of (organization_members
// is membership; roles are separate — a zero-role member still sees the org
// shell, just with no projects/permissions).
export async function listOrganizationsForProfile(
  gotrueId: string
): Promise<PlatformOrganizationRow[]> {
  const { data, error } = await executePlatformQuery<PlatformOrganizationRow>({
    query: `
      select o.id, o.slug, o.name
      from platform.organizations o
      join platform.organization_members om on om.organization_id = o.id
      join platform.profiles pr on pr.id = om.profile_id
      where pr.gotrue_id = $1
      order by o.id
    `,
    parameters: [gotrueId],
  })
  if (error) throw error
  return data ?? []
}

const MISSING_ENFORCE_MFA_COLUMN = 'column "enforce_mfa" does not exist'

let warnedMissingEnforceMfa = false

// [self-platform] M3.1: org MFA-enforcement flag (05-mfa-enforcement.sql).
// Reads degrade to false on a pre-05 database (warn once, fail soft — same
// pattern as the analytics-column degradation in projects.ts); writes
// propagate the error so a PATCH against an unmigrated db fails honestly.
export async function getOrgMfaEnforced(orgId: number): Promise<boolean> {
  const { data, error } = await executePlatformQuery<{ enforce_mfa: boolean }>({
    query: 'select enforce_mfa from platform.organizations where id = $1',
    parameters: [orgId],
  })
  if (error) {
    if (!error.message.includes(MISSING_ENFORCE_MFA_COLUMN)) throw error
    if (!warnedMissingEnforceMfa) {
      warnedMissingEnforceMfa = true
      console.warn(
        '[self-platform] platform.organizations.enforce_mfa missing (pre-M3.1 platform-db) — reporting MFA enforcement as OFF. Run docker/volumes/platform/migrations/05-mfa-enforcement.sql to upgrade.'
      )
    }
    return false
  }
  return data?.[0]?.enforce_mfa ?? false
}

export async function setOrgMfaEnforced(orgId: number, enforced: boolean): Promise<void> {
  const { error } = await executePlatformQuery({
    query: 'update platform.organizations set enforce_mfa = $2, updated_at = now() where id = $1',
    parameters: [orgId, enforced],
  })
  if (error) throw error
}
