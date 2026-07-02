// [self-platform] Project-list assembly: registry rows → the api-types
// list shapes (org-scoped + global V2). Falls back to the single
// DEFAULT_PROJECT when the registry is empty — preserves M1 behavior for a
// freshly bootstrapped deployment with nothing registered yet.
import type { components } from 'api-types'

import { getOrganizationBySlug, listOrganizations } from './organizations'
import {
  countAllProjects,
  countProjectsByOrgId,
  listAllProjects,
  listProjectsByOrgId,
  type PlatformProjectRow,
} from './projects'
import { DEFAULT_PROJECT } from '@/lib/constants/api'

export type OrganizationProjectsResponse = components['schemas']['OrganizationProjectsResponse']
export type ListProjectsPaginatedResponse = components['schemas']['ListProjectsPaginatedResponse']
type OrgProjectItem = OrganizationProjectsResponse['projects'][number]
type GlobalProjectItem = ListProjectsPaginatedResponse['projects'][number]

// [self-platform] Schema shape + the M1-era extras the M2 list shipped
// (id/organization_id/organization_slug/preview_branch_refs). Untyped UI
// paths may still read them at runtime; extras are additive so the value
// stays assignable to OrganizationProjectsResponse['projects'][number].
// Revisit (drop extras) when M3 reworks the list consumers.
type OrgProjectItemCompat = OrgProjectItem & {
  id: number
  organization_id: number
  organization_slug: string
  preview_branch_refs: string[]
}

// Registry rows have no inserted_at column; mirror the fixed placeholder
// used by the other self-platform mappers (projects.ts).
const PLACEHOLDER_INSERTED_AT = '2021-08-02T06:40:40.646Z'

function toOrgProjectItem(row: PlatformProjectRow, orgSlug: string): OrgProjectItemCompat {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    organization_id: row.organization_id,
    organization_slug: orgSlug,
    cloud_provider: row.cloud_provider,
    region: row.region,
    inserted_at: PLACEHOLDER_INSERTED_AT,
    integration_source: null,
    is_branch: false,
    preview_branch_refs: [],
    status: row.status as OrgProjectItem['status'],
    databases: [
      {
        identifier: row.ref,
        cloud_provider: row.cloud_provider,
        region: row.region,
        status: row.status as OrgProjectItem['databases'][number]['status'],
        type: 'PRIMARY',
      },
    ],
  }
}

function defaultOrgProject(orgSlug: string): OrgProjectItemCompat {
  return {
    id: DEFAULT_PROJECT.id,
    ref: DEFAULT_PROJECT.ref,
    name: DEFAULT_PROJECT.name,
    organization_id: DEFAULT_PROJECT.organization_id,
    organization_slug: orgSlug,
    cloud_provider: DEFAULT_PROJECT.cloud_provider,
    region: DEFAULT_PROJECT.region,
    inserted_at: DEFAULT_PROJECT.inserted_at,
    integration_source: null,
    is_branch: false,
    preview_branch_refs: [],
    status: DEFAULT_PROJECT.status as OrgProjectItem['status'],
    databases: [
      {
        identifier: DEFAULT_PROJECT.ref,
        cloud_provider: DEFAULT_PROJECT.cloud_provider,
        region: DEFAULT_PROJECT.region,
        status: DEFAULT_PROJECT.status as OrgProjectItem['databases'][number]['status'],
        type: 'PRIMARY',
      },
    ],
  }
}

function toGlobalProjectItem(row: PlatformProjectRow, orgSlug: string): GlobalProjectItem {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    organization_id: row.organization_id,
    organization_slug: orgSlug,
    cloud_provider: row.cloud_provider,
    status: row.status,
    region: row.region,
    inserted_at: PLACEHOLDER_INSERTED_AT,
    is_branch_enabled: false,
    is_physical_backups_enabled: null,
    preview_branch_refs: [],
    subscription_id: null,
  }
}

function defaultGlobalProject(): GlobalProjectItem {
  return {
    ...DEFAULT_PROJECT,
    organization_slug: 'default',
    is_branch_enabled: false,
    is_physical_backups_enabled: null,
    preview_branch_refs: [],
    subscription_id: null,
  }
}

// [self-platform] Org-scoped project list (org home + project selector).
// Returns null when the org slug doesn't resolve — the route maps that to
// a 404. pagination.count is the org's TOTAL project count.
export async function listOrgProjectsV2(
  slug: string,
  limit = 100,
  offset = 0
): Promise<OrganizationProjectsResponse | null> {
  const org = await getOrganizationBySlug(slug)
  if (!org) return null

  const [rows, total] = await Promise.all([
    listProjectsByOrgId(org.id, limit, offset),
    countProjectsByOrgId(org.id),
  ])

  if (total === 0) {
    // Empty registry: single default-project fallback (M1 behavior). The
    // fallback "row" only exists on page one; count stays 1.
    return {
      pagination: { count: 1, limit, offset },
      projects: offset === 0 ? [defaultOrgProject(org.slug)] : [],
    }
  }

  return {
    pagination: { count: total, limit, offset },
    projects: rows.map((row) => toOrgProjectItem(row, org.slug)),
  }
}

// [self-platform] Global project list (GET /platform/projects, V2 shape).
// M2 lists every registered project: the M1 permissions model is a
// wildcard over a single org, so "all registered projects" and "the
// caller's org's projects" are equivalent for now.
// TODO(M3): filter by the caller's profile org membership once
// multi-org membership exists.
export async function listAllProjectsV2(
  limit = 100,
  offset = 0
): Promise<ListProjectsPaginatedResponse> {
  const [rows, total, orgs] = await Promise.all([
    listAllProjects(limit, offset),
    countAllProjects(),
    listOrganizations(),
  ])
  const slugById = new Map(orgs.map((org) => [org.id, org.slug]))

  if (total === 0) {
    return {
      pagination: { count: 1, limit, offset },
      projects: offset === 0 ? [defaultGlobalProject()] : [],
    }
  }

  return {
    pagination: { count: total, limit, offset },
    projects: rows.map((row) =>
      toGlobalProjectItem(row, slugById.get(row.organization_id) ?? 'default')
    ),
  }
}
