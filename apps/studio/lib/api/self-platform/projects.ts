// [self-platform] platform.projects data access + api-types contract mapping.
// Mirrors organizations.ts pattern. Mappers take the pg-meta-encrypted
// connection string(s) as args (produced by resolve-connection.ts) so this
// module stays free of the transport-encryption concern.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

export interface PlatformProjectRow {
  id: number
  ref: string
  organization_id: number
  name: string
  status: string
  cloud_provider: string
  region: string
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_user_readonly: string
  kong_url: string
  rest_url: string
  db_pass_enc: string
  service_key_enc: string
  anon_key_enc: string
  jwt_secret_enc: string
  publishable_key_enc: string | null
  secret_key_enc: string | null
  logflare_url: string | null
  logflare_token_enc: string | null
}

type ProjectDetailResponse = components['schemas']['ProjectDetailResponse']

export const PROJECT_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc
`

// [self-platform] Pre-M2.1 platform-db data dirs lack the analytics columns
// (03-analytics.sql applied manually on upgrades). Retry without them and
// treat both as NULL so an un-migrated deployment keeps working — mirrors
// the missing-table handling in resolve-connection.ts.
const LEGACY_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc
`
const MISSING_ANALYTICS_COLUMN = 'column "logflare_url" does not exist'

let warnedMissingAnalyticsColumns = false

async function queryProjectRows(
  suffix: string,
  parameters?: unknown[]
): Promise<PlatformProjectRow[]> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects ${suffix}`,
    parameters,
  })
  if (!error) return data ?? []
  if (!error.message.includes(MISSING_ANALYTICS_COLUMN)) throw error
  if (!warnedMissingAnalyticsColumns) {
    warnedMissingAnalyticsColumns = true
    console.warn(
      '[self-platform] platform.projects has no analytics columns (pre-M2.1 platform-db) — treating logflare_url/logflare_token_enc as NULL. Run docker/volumes/platform/migrations/03-analytics.sql to upgrade.'
    )
  }
  const legacy = await executePlatformQuery<
    Omit<PlatformProjectRow, 'logflare_url' | 'logflare_token_enc'>
  >({
    query: `select ${LEGACY_SELECT_COLUMNS} from platform.projects ${suffix}`,
    parameters,
  })
  if (legacy.error) throw legacy.error
  return (legacy.data ?? []).map((row) => ({
    ...row,
    logflare_url: null,
    logflare_token_enc: null,
  }))
}

export async function getProjectByRef(ref: string): Promise<PlatformProjectRow | null> {
  const rows = await queryProjectRows('where ref = $1', [ref])
  return rows[0] ?? null
}

export async function listProjectsByOrgId(
  orgId: number,
  limit = 100,
  offset = 0
): Promise<PlatformProjectRow[]> {
  return queryProjectRows('where organization_id = $1 order by id limit $2 offset $3', [
    orgId,
    limit,
    offset,
  ])
}

export async function listAllProjects(limit = 100, offset = 0): Promise<PlatformProjectRow[]> {
  return queryProjectRows('order by id limit $1 offset $2', [limit, offset])
}

// [self-platform] Total-row counts for the paginated list routes. These hit
// platform.projects directly (no analytics columns), so — unlike
// queryProjectRows — they don't need the pre-M2.1 degradation retry.
export async function countProjectsByOrgId(orgId: number): Promise<number> {
  const { data, error } = await executePlatformQuery<{ count: number }>({
    query: 'select count(*)::int as count from platform.projects where organization_id = $1',
    parameters: [orgId],
  })
  if (error) throw error
  return data?.[0]?.count ?? 0
}

export async function countAllProjects(): Promise<number> {
  const { data, error } = await executePlatformQuery<{ count: number }>({
    query: 'select count(*)::int as count from platform.projects',
  })
  if (error) throw error
  return data?.[0]?.count ?? 0
}

// [self-platform] M3.0 visibility-scoped variants. `orgIds`/`ids` are always
// server-derived from MemberContext (never user input); arrays go through
// parameterized `= any($n)`.
export async function listProjectsVisible(
  orgIds: number[],
  ids: number[],
  limit = 100,
  offset = 0
): Promise<PlatformProjectRow[]> {
  return queryProjectRows(
    'where (organization_id = any($1) or id = any($2)) order by id limit $3 offset $4',
    [orgIds, ids, limit, offset]
  )
}

export async function countProjectsVisible(orgIds: number[], ids: number[]): Promise<number> {
  const { data, error } = await executePlatformQuery<{ count: number }>({
    query:
      'select count(*)::int as count from platform.projects where (organization_id = any($1) or id = any($2))',
    parameters: [orgIds, ids],
  })
  if (error) throw error
  return data?.[0]?.count ?? 0
}

export async function listProjectsByOrgIdAndIds(
  orgId: number,
  ids: number[],
  limit = 100,
  offset = 0
): Promise<PlatformProjectRow[]> {
  return queryProjectRows(
    'where organization_id = $1 and id = any($2) order by id limit $3 offset $4',
    [orgId, ids, limit, offset]
  )
}

export async function countProjectsByOrgIdAndIds(orgId: number, ids: number[]): Promise<number> {
  const { data, error } = await executePlatformQuery<{ count: number }>({
    query:
      'select count(*)::int as count from platform.projects where organization_id = $1 and id = any($2)',
    parameters: [orgId, ids],
  })
  if (error) throw error
  return data?.[0]?.count ?? 0
}

export function toProjectDetailResponse(
  row: PlatformProjectRow,
  connectionStringEnc: string
): ProjectDetailResponse {
  return {
    cloud_provider: row.cloud_provider,
    connectionString: connectionStringEnc,
    db_host: row.db_host,
    high_availability: false,
    id: row.id,
    inserted_at: '2021-08-02T06:40:40.646Z',
    integration_source: null,
    is_branch_enabled: false,
    is_physical_backups_enabled: false,
    name: row.name,
    organization_id: row.organization_id,
    ref: row.ref,
    region: row.region,
    restUrl: row.rest_url,
    status: row.status as ProjectDetailResponse['status'],
    subscription_id: '',
    updated_at: '2021-08-02T06:40:40.646Z',
  }
}
