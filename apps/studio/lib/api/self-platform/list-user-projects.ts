// [self-platform] Project-list assembly: registry rows → the project-switcher
// list shapes (org-scoped + global V2). Falls back to the single
// DEFAULT_PROJECT when the registry has no rows in scope — preserves M1
// behavior for a freshly bootstrapped deployment with nothing registered yet.
import { getOrganizationBySlug, listOrganizations } from './organizations'
import { listAllProjects, listProjectsByOrgId, type PlatformProjectRow } from './projects'
import { DEFAULT_PROJECT } from '@/lib/constants/api'

// Registry rows have no inserted_at column; mirror the fixed placeholder
// used by the other self-platform mappers (projects.ts).
const PLACEHOLDER_INSERTED_AT = '2021-08-02T06:40:40.646Z'

interface Pagination {
  count: number
  limit: number
  offset: number
}

interface OrgProjectListItem {
  id: number
  ref: string
  name: string
  organization_id: number
  cloud_provider: string
  status: string
  region: string
  inserted_at: string
  organization_slug: string
  is_branch: boolean
  preview_branch_refs: string[]
  databases: { identifier: string; region: string; status: string; type: 'PRIMARY' }[]
}

interface GlobalProjectListItem {
  id: number
  ref: string
  name: string
  organization_id: number
  cloud_provider: string
  status: string
  region: string
  inserted_at: string
  organization_slug: string
  preview_branch_refs: string[]
}

function toOrgProjectListItem(row: PlatformProjectRow, orgSlug: string): OrgProjectListItem {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    organization_id: row.organization_id,
    cloud_provider: row.cloud_provider,
    status: row.status,
    region: row.region,
    inserted_at: PLACEHOLDER_INSERTED_AT,
    organization_slug: orgSlug,
    is_branch: false,
    preview_branch_refs: [],
    databases: [{ identifier: row.ref, region: row.region, status: row.status, type: 'PRIMARY' }],
  }
}

function defaultOrgProject(orgSlug: string): OrgProjectListItem {
  return {
    ...DEFAULT_PROJECT,
    organization_slug: orgSlug,
    is_branch: false,
    preview_branch_refs: [],
    databases: [
      {
        identifier: DEFAULT_PROJECT.ref,
        region: DEFAULT_PROJECT.region,
        status: DEFAULT_PROJECT.status,
        type: 'PRIMARY',
      },
    ],
  }
}

function toGlobalProjectListItem(row: PlatformProjectRow, orgSlug: string): GlobalProjectListItem {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    organization_id: row.organization_id,
    cloud_provider: row.cloud_provider,
    status: row.status,
    region: row.region,
    inserted_at: PLACEHOLDER_INSERTED_AT,
    organization_slug: orgSlug,
    preview_branch_refs: [],
  }
}

// [self-platform] Org-scoped project list (org home + project selector).
// Returns null when the org slug doesn't resolve — the route maps that to
// a 404.
export async function listOrgProjectsV2(
  slug: string,
  limit = 100,
  offset = 0
): Promise<{ pagination: Pagination; projects: OrgProjectListItem[] } | null> {
  const org = await getOrganizationBySlug(slug)
  if (!org) return null

  const rows = await listProjectsByOrgId(org.id)
  const projects =
    rows.length > 0
      ? rows.map((row) => toOrgProjectListItem(row, org.slug))
      : [defaultOrgProject(org.slug)]

  return {
    pagination: { count: projects.length, limit, offset },
    projects,
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
): Promise<{ pagination: Pagination; projects: GlobalProjectListItem[] }> {
  const [rows, orgs] = await Promise.all([listAllProjects(), listOrganizations()])
  const slugById = new Map(orgs.map((org) => [org.id, org.slug]))

  const projects =
    rows.length > 0
      ? rows.map((row) =>
          toGlobalProjectListItem(row, slugById.get(row.organization_id) ?? 'default')
        )
      : [{ ...DEFAULT_PROJECT, organization_slug: 'default', preview_branch_refs: [] as string[] }]

  return {
    pagination: { count: projects.length, limit, offset },
    projects,
  }
}
