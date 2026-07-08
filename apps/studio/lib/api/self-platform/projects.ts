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
  metrics_url: string | null
  metrics_token_enc: string | null
  container_name: string | null
  k8s_namespace: string | null
  k8s_pod_selector: string | null
  stack_kind: string
  stack_meta: Record<string, unknown>
}

type ProjectDetailResponse = components['schemas']['ProjectDetailResponse']

export const PROJECT_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
  metrics_url, metrics_token_enc, stack_kind, stack_meta, container_name,
  k8s_namespace, k8s_pod_selector
`

// [self-platform] M6.4-era list (container_name, no k8s identity) — retry tier
// for a platform-db that has 10-container.sql but not 11-k8s-identity.sql.
export const M64_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
  metrics_url, metrics_token_enc, stack_kind, stack_meta, container_name
`
export const MISSING_K8S_COLUMN = 'column "k8s_namespace" does not exist'

// [self-platform] M6.3-era list (metrics + stack, no container_name) — used
// when the platform db predates 10-container.sql. Checked before the metrics
// tier so a 01-09-but-not-10 db degrades container_name → null, not 500.
export const M63_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
  metrics_url, metrics_token_enc, stack_kind, stack_meta
`
export const MISSING_CONTAINER_COLUMN = 'column "container_name" does not exist'

// [self-platform] M6.2-era list (stack + analytics, no metrics columns) —
// degradation tier for a platform-db that has 07-stack-metadata.sql (and
// 03-analytics.sql) applied but not 09-metrics.sql, i.e. everything through
// M6.2 but not M6.3 T2's metrics columns.
export const M62_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
  stack_kind, stack_meta
`
export const MISSING_METRICS_COLUMN = 'column "metrics_url" does not exist'

// [self-platform] M2.1-era list (analytics, no stack columns) — degradation
// tier for a platform-db that has 03-analytics.sql but not
// 07-stack-metadata.sql applied.
export const M21_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc
`
export const MISSING_STACK_COLUMN = 'column "stack_kind" does not exist'

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

let warnedMissingK8sColumns = false
let warnedMissingContainerColumn = false
let warnedMissingMetricsColumns = false
let warnedMissingStackColumns = false
let warnedMissingAnalyticsColumns = false

async function queryProjectRows(
  suffix: string,
  parameters?: unknown[]
): Promise<PlatformProjectRow[]> {
  const attempt = (columns: string) =>
    executePlatformQuery<PlatformProjectRow>({
      query: `select ${columns} from platform.projects ${suffix}`,
      parameters,
    })

  // [self-platform] Tier order matters. k8s_namespace/k8s_pod_selector are the
  // newest columns (11-k8s-identity.sql), so this check must run FIRST — a
  // pre-D3 (but post-M6.4) db degrades the k8s columns → null via the M64
  // retry below rather than falling through the container/metrics/stack/
  // analytics tiers. container_name is next-newest (10-container.sql); its
  // retry (M63_SELECT_COLUMNS) still selects it, so a pre-M6.4 db fails that
  // retry with MISSING_CONTAINER_COLUMN and falls through. metrics_url
  // precedes stack_kind in PROJECT_SELECT_COLUMNS, so Postgres reports the
  // metrics column first when both are missing — that check runs next so a
  // pre-09 (but post-07) db is caught there. Its retry (M62_SELECT_COLUMNS)
  // still selects stack_kind/stack_meta, so a pre-07 db fails that retry with
  // MISSING_STACK_COLUMN and falls through to the next tier below, which in
  // turn still selects logflare_url/logflare_token_enc, so a pre-M2.1 db
  // fails that with MISSING_ANALYTICS_COLUMN and falls through to
  // LEGACY_SELECT_COLUMNS. Every vintage lands on the right tier.
  let result = await attempt(PROJECT_SELECT_COLUMNS)
  if (result.error?.message.includes(MISSING_K8S_COLUMN)) {
    if (!warnedMissingK8sColumns) {
      warnedMissingK8sColumns = true
      console.warn(
        '[self-platform] platform.projects has no k8s identity columns (pre-11 platform-db) — treating k8s_namespace/k8s_pod_selector as NULL. Run docker/volumes/platform/migrations/11-k8s-identity.sql to upgrade.'
      )
    }
    result = await attempt(M64_SELECT_COLUMNS)
  }
  if (result.error?.message.includes(MISSING_CONTAINER_COLUMN)) {
    if (!warnedMissingContainerColumn) {
      warnedMissingContainerColumn = true
      console.warn(
        '[self-platform] platform.projects has no container_name column (pre-M6.4 platform-db) — treating container_name as NULL. Run docker/volumes/platform/migrations/10-container.sql to upgrade.'
      )
    }
    result = await attempt(M63_SELECT_COLUMNS)
  }
  if (result.error?.message.includes(MISSING_METRICS_COLUMN)) {
    if (!warnedMissingMetricsColumns) {
      warnedMissingMetricsColumns = true
      console.warn(
        '[self-platform] platform.projects has no metrics columns (pre-M6.3 platform-db) — treating metrics_url/metrics_token_enc as NULL. Run docker/volumes/platform/migrations/09-metrics.sql to upgrade.'
      )
    }
    result = await attempt(M62_SELECT_COLUMNS)
  }
  if (result.error?.message.includes(MISSING_STACK_COLUMN)) {
    if (!warnedMissingStackColumns) {
      warnedMissingStackColumns = true
      console.warn(
        '[self-platform] platform.projects has no stack columns (pre-M5.0 platform-db). ' +
          'Run docker/volumes/platform/migrations/07-stack-metadata.sql to upgrade.'
      )
    }
    result = await attempt(M21_SELECT_COLUMNS)
  }
  if (result.error?.message.includes(MISSING_ANALYTICS_COLUMN)) {
    if (!warnedMissingAnalyticsColumns) {
      warnedMissingAnalyticsColumns = true
      console.warn(
        '[self-platform] platform.projects has no analytics columns (pre-M2.1 platform-db) — treating logflare_url/logflare_token_enc as NULL. Run docker/volumes/platform/migrations/03-analytics.sql to upgrade.'
      )
    }
    result = await attempt(LEGACY_SELECT_COLUMNS)
  }
  if (result.error) throw result.error
  // Degraded tiers lack the newer columns — normalize so consumers always
  // see the full row shape. `r` is typed as the full PlatformProjectRow
  // regardless of tier, so a defaults-then-spread literal would trip
  // TS2783 (the spread would silently clobber the literal default);
  // spread first and fall back per-field instead — same effect, since a
  // degraded row simply lacks the key (accessing it yields `undefined`).
  return (result.data ?? []).map((r) => ({
    ...r,
    logflare_url: r.logflare_url ?? null,
    logflare_token_enc: r.logflare_token_enc ?? null,
    metrics_url: r.metrics_url ?? null,
    metrics_token_enc: r.metrics_token_enc ?? null,
    container_name: r.container_name ?? null,
    k8s_namespace: r.k8s_namespace ?? null,
    k8s_pod_selector: r.k8s_pod_selector ?? null,
    stack_kind: r.stack_kind ?? 'external',
    stack_meta: r.stack_meta ?? ({} as Record<string, unknown>),
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

// [self-platform] M6.1: refs of shared-db rows cloned from this host — GET
// detail exposes them so the edit panel can warn before a propagating save
// (spec §5). Pre-M5.0 platform-dbs lack stack columns; the caller degrades
// on MISSING_STACK_COLUMN like queryProjectRows does.
export async function listSharedDbChildRefs(hostRef: string): Promise<string[]> {
  const { data, error } = await executePlatformQuery<{ ref: string }>({
    query: `select ref from platform.projects
      where stack_kind = 'shared-db' and stack_meta->>'host_ref' = $1
      order by ref`,
    parameters: [hostRef],
  })
  if (error) throw error
  return (data ?? []).map((r) => r.ref)
}
