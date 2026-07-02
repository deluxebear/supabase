// [self-platform] platform.organizations data access + contract mapping.
// Plan is hard-coded 'enterprise' so plan/entitlement-gated UI stays open
// (spec §4.5); billing fields are nulled — self-platform has no billing.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

export type PlatformOrganizationRow = { id: number; slug: string; name: string }

type OrganizationResponse = components['schemas']['OrganizationResponse']
type OrganizationSlugResponse = components['schemas']['OrganizationSlugResponse']

const ENTERPRISE_PLAN = { id: 'enterprise' as const, name: 'Enterprise' }

export function toOrganizationResponse(row: PlatformOrganizationRow): OrganizationResponse {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    billing_email: null,
    billing_partner: null,
    integration_source: null,
    is_owner: true,
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
