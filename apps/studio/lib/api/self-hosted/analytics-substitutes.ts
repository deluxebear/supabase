// [self-platform] M6.2: named-endpoint substitution (spec §4). A stock
// Logflare postgres backend cannot serve these seeded/unseeded endpoints
// (usage.api-counts fails BQ→PG translation; the other three are never
// seeded), so we rewrite them onto the sandboxable logs.all endpoint with
// dual-dialect SQL (valid BigQuery too — no backend detection needed).
// UNION ALL is categorically broken in the PG translator, hence one query
// per service table for service-health (live-bisected 2026-07-06).
import { AnalyticsResult, retrieveAnalyticsData, RetrieveAnalyticsDataOptions } from './logs'
import { WrappedErrorResult, WrappedResult } from './types'

// Type-guarded helper — results.find(r => r.error) doesn't narrow the
// discriminated WrappedResult union on its own.
function firstError<T>(results: WrappedResult<T>[]): WrappedErrorResult | undefined {
  return results.find((r): r is WrappedErrorResult => r.error !== undefined)
}

export class InvalidAnalyticsParams extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAnalyticsParams'
  }
}

const SUBSTITUTED = new Set([
  'usage.api-counts',
  'service-health',
  'auth.metrics',
  'functions.combined-stats',
  'functions.last-hour-stats',
])
export function isSubstitutedEndpoint(name: string): boolean {
  return SUBSTITUTED.has(name)
}

// [self-platform] PLAN REFINEMENT over spec (ledger): promise-TTL cache.
// useServiceHealthMetrics fires one HTTP request per service key with
// identical params (7x fan-out), and the home usage charts poll on an
// interval — this absorbs both without changing observed freshness by more
// than the TTL.
export const SUBSTITUTE_CACHE_TTL_MS = 20_000
const cache = new Map<string, { at: number; promise: Promise<WrappedResult<AnalyticsResult>> }>()
export function clearSubstituteCache(): void {
  cache.clear()
}
// [self-platform] M6.3 fold-in: test-only visibility into the cache's live
// size, so the sweep-on-insert behavior (below) can be pinned without
// reaching into the module's private `cache` binding.
export function substituteCacheSizeForTest(): number {
  return cache.size
}

const microsToIso = (us: number) => new Date(Math.floor(us / 1000)).toISOString()

const INTERVALS: Record<string, { trunc: 'minute' | 'hour' | 'day'; spanMs: number }> = {
  '5min': { trunc: 'minute', spanMs: 5 * 60_000 },
  '15min': { trunc: 'minute', spanMs: 15 * 60_000 },
  '1hr': { trunc: 'minute', spanMs: 60 * 60_000 },
  '1day': { trunc: 'hour', spanMs: 24 * 60 * 60_000 },
  '7day': { trunc: 'day', spanMs: 7 * 24 * 60 * 60_000 },
}
const GRANULARITIES = new Set(['minute', 'hour', 'day'])
const FUNCTION_ID_RE = /^[A-Za-z0-9_-]+$/

type Params = Record<string, string | undefined>
// A builder validates+prepares its request(s) SYNCHRONOUSLY (throwing
// InvalidAnalyticsParams before any wire call / cache interaction), then
// returns a thunk that performs the actual Logflare round-trip(s).
type Builder = (projectRef: string, params: Params) => () => Promise<WrappedResult<AnalyticsResult>>

function resolveInterval(interval: string | undefined) {
  const cfg = interval ? INTERVALS[interval] : undefined
  if (!cfg) throw new InvalidAnalyticsParams(`Invalid interval: ${interval}`)
  return cfg
}

// ---------------------------------------------------------------------------
// usage.api-counts (LIVE-VERIFIED 2026-07-06: correct shape and merges)
// ---------------------------------------------------------------------------
// [self-platform] M6.3 fold-in rider ③: row shape per this builder's own SQL
// select list (all four counts are `countif(...)` — always present, `?? 0`
// below only guards a genuinely empty bucket row).
interface UsageApiCountsRow {
  timestamp: number
  total_rest_requests?: number
  total_auth_requests?: number
  total_storage_requests?: number
  total_realtime_requests?: number
}

const buildUsageApiCounts: Builder = (projectRef, params) => {
  const { trunc, spanMs } = resolveInterval(params.interval)
  const isoStart = new Date(Date.now() - spanMs).toISOString()
  const sql = `select timestamp_trunc(t.timestamp, ${trunc}) as timestamp,
  countif(regexp_contains(r.path, '^/rest/')) as total_rest_requests,
  countif(regexp_contains(r.path, '^/auth/')) as total_auth_requests,
  countif(regexp_contains(r.path, '^/storage/')) as total_storage_requests,
  countif(regexp_contains(r.path, '^/realtime/')) as total_realtime_requests
from edge_logs t
  cross join unnest(t.metadata) as m
  cross join unnest(m.request) as r
group by 1
order by 1 asc`

  return async () => {
    const { data, error } = await retrieveAnalyticsData({
      name: 'logs.all',
      projectRef,
      params: { sql, iso_timestamp_start: isoStart },
    })
    if (error) return { data: undefined, error }
    const rows = ((data?.result ?? []) as UsageApiCountsRow[]).map((row) => ({
      timestamp: microsToIso(row.timestamp),
      total_rest_requests: row.total_rest_requests ?? 0,
      total_auth_requests: row.total_auth_requests ?? 0,
      total_storage_requests: row.total_storage_requests ?? 0,
      total_realtime_requests: row.total_realtime_requests ?? 0,
    }))
    return { data: { result: rows }, error: undefined }
  }
}

// ---------------------------------------------------------------------------
// service-health — one query per service table (UNION ALL is categorically
// broken on the PG translator, live-bisected).
// ---------------------------------------------------------------------------
const CLASSIFIED_TABLES: Array<{ table: string; joins: string; error: string; warning: string }> = [
  {
    table: 'edge_logs',
    joins: 'cross join unnest(t.metadata) as m cross join unnest(m.response) as resp',
    error: 'resp.status_code >= 500',
    warning: 'resp.status_code >= 400 and resp.status_code < 500',
  },
  {
    table: 'function_edge_logs',
    joins: 'cross join unnest(t.metadata) as m cross join unnest(m.response) as resp',
    error: 'resp.status_code >= 500',
    warning: 'resp.status_code >= 400 and resp.status_code < 500',
  },
  {
    table: 'auth_logs',
    joins: 'cross join unnest(t.metadata) as m',
    error: "m.level = 'error' or m.level = 'fatal'",
    warning: "m.level = 'warning'",
  },
  {
    // [self-platform] live-pinned 2026-07-06: p.error_severity field access
    // works fine on real data (postgres_logs is never empty on a running
    // stack) — full classification kept, no degrade needed.
    table: 'postgres_logs',
    joins: 'cross join unnest(t.metadata) as m cross join unnest(m.parsed) as p',
    error: "p.error_severity = 'ERROR' or p.error_severity = 'FATAL' or p.error_severity = 'PANIC'",
    warning: "p.error_severity = 'WARNING'",
  },
]
const TOTAL_ONLY_TABLES = ['storage_logs', 'realtime_logs', 'postgrest_logs']

// [self-platform] M6.3 fold-in rider ③: row shape shared by both the
// classified-table and total-only-table SQL above — `error`/`warning` are
// simply absent from the total-only select list, hence optional here too.
interface ServiceHealthSqlRow {
  timestamp: number
  total?: number
  error?: number
  warning?: number
}
interface ServiceHealthCounts {
  ok: number
  warning: number
  error: number
  total: number
}
// Nested-by-table result row: `timestamp` plus one `ServiceHealthCounts`
// entry per probed table (keyed by table name, e.g. `edge_logs`).
interface ServiceHealthBucket {
  timestamp: string
  [table: string]: ServiceHealthCounts | string
}

const buildServiceHealth: Builder = (projectRef, params) => {
  const granularity = params.granularity ?? 'hour'
  if (!GRANULARITIES.has(granularity)) {
    throw new InvalidAnalyticsParams(`Invalid granularity: ${granularity}`)
  }
  const windowParams: Params = {}
  if (params.iso_timestamp_start) windowParams.iso_timestamp_start = params.iso_timestamp_start
  if (params.iso_timestamp_end) windowParams.iso_timestamp_end = params.iso_timestamp_end

  const queries = [
    ...CLASSIFIED_TABLES.map(({ table, joins, error, warning }) => ({
      table,
      sql: `select timestamp_trunc(t.timestamp, ${granularity}) as timestamp, countif(${error}) as error, countif(${warning}) as warning, count(t.id) as total from ${table} t ${joins} group by 1 order by 1 asc`,
    })),
    ...TOTAL_ONLY_TABLES.map((table) => ({
      table,
      sql: `select timestamp_trunc(t.timestamp, ${granularity}) as timestamp, count(t.id) as total from ${table} t group by 1 order by 1 asc`,
    })),
  ]

  return async () => {
    const results = await Promise.all(
      queries.map(({ sql }) =>
        retrieveAnalyticsData({ name: 'logs.all', projectRef, params: { sql, ...windowParams } })
      )
    )
    // First underlying error short-circuits the whole call with that error.
    const failed = firstError(results)
    if (failed) return { data: undefined, error: failed.error }

    const buckets = new Map<string, ServiceHealthBucket>()
    queries.forEach(({ table }, i) => {
      const rows = (results[i].data?.result ?? []) as ServiceHealthSqlRow[]
      for (const row of rows) {
        const timestamp = microsToIso(row.timestamp)
        const total = row.total ?? 0
        const error = row.error ?? 0
        const warning = row.warning ?? 0
        const ok = Math.max(0, total - error - warning)
        const bucket = buckets.get(timestamp) ?? { timestamp }
        bucket[table] = { ok, warning, error, total }
        buckets.set(timestamp, bucket)
      }
    })

    const zeroed = { ok: 0, warning: 0, error: 0, total: 0 }
    const allTables = queries.map((q) => q.table)
    const rows = [...buckets.values()]
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
      .map((row) => {
        const merged: ServiceHealthBucket = { timestamp: row.timestamp }
        for (const table of allTables) {
          merged[table] = row[table] ?? zeroed
        }
        return merged
      })
    return { data: { result: rows }, error: undefined }
  }
}

// ---------------------------------------------------------------------------
// auth.metrics — current+previous windows, 2 queries each (auth_logs +
// edge_logs). PRIMARY template used: json_value + count(distinct json_value)
// LIVE-PINNED OK 2026-07-06 (200, correct shape) — no fallback needed.
// where regexp_contains(...) also LIVE-PINNED OK (filtered count 4 < total
// 51 on edge_logs) — kept as specified, no countif-fold needed.
// ---------------------------------------------------------------------------
const AUTH_LOGS_SQL = `select
  count(distinct json_value(t.event_message, '$.auth_event.actor_id')) as active_users,
  countif(json_value(t.event_message, '$.auth_event.action') = 'user_signedup') as sign_up_count,
  countif(json_value(t.event_message, '$.auth_event.action') = 'user_recovery_requested') as password_reset_requests,
  countif(m.level = 'error' or m.level = 'fatal') as auth_total_errors,
  count(t.id) as auth_total_requests
from auth_logs t cross join unnest(t.metadata) as m`

const AUTH_EDGE_LOGS_SQL = `select
  countif(resp.status_code >= 400) as api_error_requests,
  count(t.id) as api_total_requests
from edge_logs t
  cross join unnest(t.metadata) as m
  cross join unnest(m.request) as r
  cross join unnest(m.response) as resp
where regexp_contains(r.path, '^/auth/')`

// [self-platform] M6.3 fold-in rider ③: row shapes per AUTH_LOGS_SQL /
// AUTH_EDGE_LOGS_SQL's own select lists above.
interface AuthLogsRow {
  active_users?: number
  sign_up_count?: number
  password_reset_requests?: number
  auth_total_errors?: number
  auth_total_requests?: number
}
interface AuthEdgeLogsRow {
  api_error_requests?: number
  api_total_requests?: number
}

const buildAuthMetrics: Builder = (projectRef, params) => {
  const { spanMs } = resolveInterval(params.interval)
  const now = Date.now()
  const windows = [
    { period: 'current' as const, start: now - spanMs, end: now },
    { period: 'previous' as const, start: now - 2 * spanMs, end: now - spanMs },
  ]

  return async () => {
    const results = await Promise.all(
      windows.flatMap(({ start, end }) => {
        const windowParams = {
          iso_timestamp_start: new Date(start).toISOString(),
          iso_timestamp_end: new Date(end).toISOString(),
        }
        return [
          retrieveAnalyticsData({
            name: 'logs.all',
            projectRef,
            params: { sql: AUTH_LOGS_SQL, ...windowParams },
          }),
          retrieveAnalyticsData({
            name: 'logs.all',
            projectRef,
            params: { sql: AUTH_EDGE_LOGS_SQL, ...windowParams },
          }),
        ]
      })
    )
    const failed = firstError(results)
    if (failed) return { data: undefined, error: failed.error }

    const rows = windows.map(({ period }, i) => {
      const authRow = (results[i * 2].data?.result?.[0] ?? {}) as AuthLogsRow
      const edgeRow = (results[i * 2 + 1].data?.result?.[0] ?? {}) as AuthEdgeLogsRow
      return {
        period,
        active_users: authRow.active_users ?? 0,
        sign_up_count: authRow.sign_up_count ?? 0,
        password_reset_requests: authRow.password_reset_requests ?? 0,
        auth_total_errors: authRow.auth_total_errors ?? 0,
        auth_total_requests: authRow.auth_total_requests ?? 0,
        api_error_requests: edgeRow.api_error_requests ?? 0,
        api_total_requests: edgeRow.api_total_requests ?? 0,
      }
    })
    return { data: { result: rows }, error: undefined }
  }
}

// ---------------------------------------------------------------------------
// functions.combined-stats — function_edge_logs + function_logs, merged by
// bucket. function_id validated against FUNCTION_ID_RE before interpolation.
// ---------------------------------------------------------------------------
// [self-platform] M6.3 fold-in rider ③: row shapes per each SQL's own select
// list (functionEdgeSql / functionLogsSql below), and the merged-by-bucket
// shape they're folded into.
interface FunctionEdgeLogsRow {
  timestamp: number
  requests_count?: number
  success_count?: number
  redirect_count?: number
  client_err_count?: number
  server_err_count?: number
}
interface FunctionLogsRow {
  timestamp: number
  log_count?: number
  log_info_count?: number
  log_warn_count?: number
  log_error_count?: number
}
type FunctionsCombinedStatsBucket = { timestamp: string } & Omit<FunctionEdgeLogsRow, 'timestamp'> &
  Omit<FunctionLogsRow, 'timestamp'>

const buildFunctionsCombinedStats: Builder = (projectRef, params) => {
  const functionId = params.function_id
  if (!functionId || !FUNCTION_ID_RE.test(functionId)) {
    throw new InvalidAnalyticsParams(`Invalid function_id: ${functionId}`)
  }
  const { trunc, spanMs } = resolveInterval(params.interval)
  const isoStart = new Date(Date.now() - spanMs).toISOString()

  // [self-platform] LIVE-PINNED 2026-07-06 (beyond the Step-1 decision
  // rules, recorded as a refinement): avg(m.execution_time_ms) /
  // max(m.execution_time_ms) 500 on the PG translator — categorical, not a
  // data-availability fluke (crashes even with a zero-row function_id
  // filter; confirmed via vector.yml — self-hosted's deno-relay-logs router
  // never populates execution_time_ms, so the source's inferred schema has
  // no numeric type for the aggregate to bind to). Omitted like the other
  // non-derivable metrics (cpu/memory/heap) — useFillTimeseriesSorted
  // zero-fills client-side (EdgeFunctionOverview.tsx:80-105).
  const functionEdgeSql = `select timestamp_trunc(t.timestamp, ${trunc}) as timestamp, count(t.id) as requests_count, countif(resp.status_code >= 200 and resp.status_code < 300) as success_count, countif(resp.status_code >= 300 and resp.status_code < 400) as redirect_count, countif(resp.status_code >= 400 and resp.status_code < 500) as client_err_count, countif(resp.status_code >= 500) as server_err_count from function_edge_logs t cross join unnest(t.metadata) as m cross join unnest(m.response) as resp where m.function_id = '${functionId}' group by 1 order by 1 asc`

  const functionLogsSql = `select timestamp_trunc(t.timestamp, ${trunc}) as timestamp, count(t.id) as log_count, countif(m.level = 'info' or m.level = 'log') as log_info_count, countif(m.level = 'warning') as log_warn_count, countif(m.level = 'error') as log_error_count from function_logs t cross join unnest(t.metadata) as m where m.function_id = '${functionId}' group by 1 order by 1 asc`

  return async () => {
    const [edgeResult, logsResult] = await Promise.all([
      retrieveAnalyticsData({
        name: 'logs.all',
        projectRef,
        params: { sql: functionEdgeSql, iso_timestamp_start: isoStart },
      }),
      retrieveAnalyticsData({
        name: 'logs.all',
        projectRef,
        params: { sql: functionLogsSql, iso_timestamp_start: isoStart },
      }),
    ])
    if (edgeResult.error) return { data: undefined, error: edgeResult.error }
    if (logsResult.error) return { data: undefined, error: logsResult.error }

    const buckets = new Map<string, FunctionsCombinedStatsBucket>()
    for (const row of (edgeResult.data?.result ?? []) as FunctionEdgeLogsRow[]) {
      const { timestamp, ...rest } = row
      const iso = microsToIso(timestamp)
      buckets.set(iso, { ...(buckets.get(iso) ?? {}), timestamp: iso, ...rest })
    }
    for (const row of (logsResult.data?.result ?? []) as FunctionLogsRow[]) {
      const { timestamp, ...rest } = row
      const iso = microsToIso(timestamp)
      buckets.set(iso, { ...(buckets.get(iso) ?? {}), timestamp: iso, ...rest })
    }
    const rows = [...buckets.values()].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
    )
    return { data: { result: rows }, error: undefined }
  }
}

// ---------------------------------------------------------------------------
// functions.last-hour-stats — M6.3 fold-in (M6.2 README promise): the per-
// function last-hour stats query is keyed entirely by function_id, which the
// self-hosted vector pipeline never populates (M6.2 structural boundary).
// Honest empty beats the categorical 500 the raw BQ SQL produced — same
// class as functions.combined-stats.
// ---------------------------------------------------------------------------
const FUNCTION_IDS_RE = /^[0-9a-zA-Z_,-]*$/
const buildFunctionsLastHourStats: Builder = (_projectRef, params) => {
  const ids = params.function_ids ?? ''
  if (!FUNCTION_IDS_RE.test(ids)) {
    throw new InvalidAnalyticsParams('Invalid function_ids')
  }
  return async () => ({ data: { result: [] }, error: undefined })
}

const BUILDERS: Record<string, Builder> = {
  'usage.api-counts': buildUsageApiCounts,
  'service-health': buildServiceHealth,
  'auth.metrics': buildAuthMetrics,
  'functions.combined-stats': buildFunctionsCombinedStats,
  'functions.last-hour-stats': buildFunctionsLastHourStats,
}

export async function retrieveSubstitutedAnalyticsData({
  name,
  projectRef,
  params,
}: RetrieveAnalyticsDataOptions): Promise<WrappedResult<AnalyticsResult>> {
  const builder = BUILDERS[name]
  if (!builder) {
    throw new InvalidAnalyticsParams(`Unsupported substituted endpoint: ${name}`)
  }

  // [self-platform] Validation happens synchronously here, outside the
  // cached thunk — an invalid request must reject on every call, never be
  // memoized as a shared rejected promise.
  const run = builder(projectRef, params ?? {})

  const key = `${projectRef}|${name}|${JSON.stringify(params ?? {}, Object.keys(params ?? {}).sort())}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && now - cached.at < SUBSTITUTE_CACHE_TTL_MS) {
    return cached.promise
  }

  const promise = run().catch((err) => {
    cache.delete(key)
    throw err
  })
  // Sweep-on-insert: drop expired entries so the map cannot grow unboundedly
  // across distinct param shapes (M6.2 deferred follow-up).
  for (const [k, entry] of cache) {
    if (now - entry.at >= SUBSTITUTE_CACHE_TTL_MS) cache.delete(k)
  }
  cache.set(key, { at: now, promise })
  return promise
}
