// [self-platform] Project-list assembly: registry rows → the api-types
// list shapes (org-scoped + global V2). Falls back to the single
// DEFAULT_PROJECT when the registry is empty — preserves M1 behavior for a
// freshly bootstrapped deployment with nothing registered yet.
import type { components } from 'api-types'

import { isOrgScopedRole, type MemberContext } from './members'
import { getOrganizationBySlug, listOrganizations } from './organizations'
import {
  countProjectsByOrgId,
  countProjectsByOrgIdAndIds,
  countProjectsVisible,
  listProjectsByOrgId,
  listProjectsByOrgIdAndIds,
  listProjectsVisible,
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
  stack_kind: string // M5.0: informational provenance for the create form's host dropdown
}

// M5.0: same compat-extra pattern as OrgProjectItemCompat above, applied to
// the global list shape.
type GlobalProjectItemCompat = GlobalProjectItem & { stack_kind: string }

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
    stack_kind: row.stack_kind,
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
    stack_kind: 'external',
  }
}

function toGlobalProjectItem(row: PlatformProjectRow, orgSlug: string): GlobalProjectItemCompat {
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
    stack_kind: row.stack_kind,
  }
}

function defaultGlobalProject(): GlobalProjectItemCompat {
  return {
    ...DEFAULT_PROJECT,
    organization_slug: 'default',
    is_branch_enabled: false,
    is_physical_backups_enabled: null,
    preview_branch_refs: [],
    subscription_id: null,
    stack_kind: 'external',
  }
}

export type ProjectVisibilityScope = 'all' | number[]

// [self-platform] Which of an org's projects the caller may see (spec §8):
// any org-scoped role -> all of them; only derived roles -> their project
// ids; no role in the org -> none.
export function visibleProjectScope(ctx: MemberContext, orgId: number): ProjectVisibilityScope {
  const orgRoles = ctx.roles.filter((role) => role.orgId === orgId)
  // [self-platform] M3.1 I1 guard: only a genuinely org-scoped role widens to
  // 'all' — an empty derived role must not (it contributes zero projectIds).
  if (orgRoles.some((role) => isOrgScopedRole(role))) return 'all'
  return [...new Set(orgRoles.flatMap((role) => role.projectIds))]
}

// [self-platform] Org-scoped project list (org home + project selector).
// Returns null when the org slug doesn't resolve — the route maps that to
// a 404. pagination.count is the org's TOTAL project count (subject to the
// caller's visibility scope — spec §8).
export async function listOrgProjectsV2(
  ctx: MemberContext,
  slug: string,
  limit = 100,
  offset = 0
): Promise<OrganizationProjectsResponse | null> {
  const org = await getOrganizationBySlug(slug)
  if (!org) return null

  const scope = visibleProjectScope(ctx, org.id)
  if (scope !== 'all' && scope.length === 0) {
    // Zero-role / no role in this org: fail closed — empty page, and no
    // default-project fallback either (spec §8).
    return { pagination: { count: 0, limit, offset }, projects: [] }
  }

  const [rows, total] =
    scope === 'all'
      ? await Promise.all([
          listProjectsByOrgId(org.id, limit, offset),
          countProjectsByOrgId(org.id),
        ])
      : await Promise.all([
          listProjectsByOrgIdAndIds(org.id, scope, limit, offset),
          countProjectsByOrgIdAndIds(org.id, scope),
        ])

  if (total === 0) {
    if (scope !== 'all') {
      // Derived scope pointing at removed projects — nothing visible.
      return { pagination: { count: 0, limit, offset }, projects: [] }
    }
    // Empty registry + role-holding member: single default-project fallback
    // (M1 behavior). The fallback "row" only exists on page one; count stays 1.
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
// M3.0: role-filtered (spec §8) — org-scoped roles contribute whole orgs,
// derived roles contribute explicit project ids, zero roles see nothing.
export async function listAllProjectsV2(
  ctx: MemberContext,
  limit = 100,
  offset = 0
): Promise<ListProjectsPaginatedResponse> {
  // Fold per-org scopes into one visibility query: org-scoped roles
  // contribute whole orgs, derived roles contribute explicit project ids.
  const orgIds: number[] = []
  const projectIds = new Set<number>()
  for (const orgId of new Set(ctx.roles.map((role) => role.orgId))) {
    const scope = visibleProjectScope(ctx, orgId)
    if (scope === 'all') orgIds.push(orgId)
    else scope.forEach((id) => projectIds.add(id))
  }
  const ids = [...projectIds]

  if (orgIds.length === 0 && ids.length === 0) {
    // Zero roles anywhere: fail closed, no default fallback (spec §8).
    return { pagination: { count: 0, limit, offset }, projects: [] }
  }

  const [rows, total, orgs] = await Promise.all([
    listProjectsVisible(orgIds, ids, limit, offset),
    countProjectsVisible(orgIds, ids),
    listOrganizations(),
  ])
  const slugById = new Map(orgs.map((org) => [org.id, org.slug]))

  if (total === 0) {
    if (orgIds.length === 0) {
      // Purely-derived visibility whose project ids no longer resolve —
      // fail closed, never the default fallback (spec §8).
      return { pagination: { count: 0, limit, offset }, projects: [] }
    }
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
