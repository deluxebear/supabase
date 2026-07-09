import { useQuery } from '@tanstack/react-query'
import { useFlag } from 'common'
import dayjs from 'dayjs'

import { edgeFunctionsKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import { executeAnalyticsSql } from '@/data/logs/execute-analytics-sql'
import { USE_LOGFLARE_PG_SQL } from '@/data/logs/logflare-dialect'
import { logsAllEndpointUrl } from '@/data/logs/logs-endpoint'
import {
  analyticsLiteral,
  joinSqlFragments,
  safeSql,
  type SafeLogSqlFragment,
} from '@/data/logs/safe-analytics-sql'
import type { ResponseError, UseCustomQueryOptions } from '@/types'

export type EdgeFunctionsLastHourStatsVariables = {
  projectRef?: string
  functionIds?: string[]
  useOtel?: boolean
}

export type EdgeFunctionLastHourStats = {
  functionId: string
  requestsCount: number
  serverErrorCount: number
  errorRate: number
}

export type EdgeFunctionsLastHourStatsResponse = Record<string, EdgeFunctionLastHourStats>

// [self-platform] M6.2 T3 Step 1 pin: `count(distinct case when …)` returned
// 200 (real data) on the Logflare PG translator — not broken. Per the
// brief's decision rule ("if the pin shows count(distinct case when) works,
// keep the BQ text in both branches instead"), no PG variant/pickDialect
// gate is added here; this template's own aggregates are unchanged from
// pre-M6.2.
//
// Live-verification finding (Step 5, beyond the Step 1 pin): this whole
// query is nonetheless non-functional on self-hosted — bare `function_id`
// (used in both the WHERE and the GROUP BY, which is this query's entire
// per-function keying) 500s categorically on `function_edge_logs`
// (docker/volumes/logs/vector.yml's `functions_logs` transform never
// populates it; same root cause T2 traced for `m.execution_time_ms`/
// `m.function_id` avg/max, generalized here to ANY reference). Unlike the
// SQL-dialect issues this task's rewrite list addresses, this is a
// data-availability gap with no SQL-only fix: the query's entire purpose is
// a per-`functionId` breakdown (`EdgeFunctionsLastHourStatsResponse` is
// keyed by it), and there is no self-hosted-populated substitute identifier
// (`m.execution_id`/`m.deployment_id` are equally never-populated, per T2's
// recon). Left as a known limitation surfacing the existing error state —
// same category as the two approx_quantiles-blocked auth percentile
// templates — rather than force-fitting an architecture change outside
// this task's SQL-variant scope. Flagged for reviewer sign-off / follow-up
// (likely a server-side substitution, mirroring T2's analytics-substitutes
// pattern, in a later milestone).
//
// [self-platform] M6.3 fold-in: the flagged follow-up above landed —
// `getEdgeFunctionsLastHourStats` now short-circuits through the
// `functions.last-hour-stats` substitute endpoint (analytics-substitutes.ts)
// when `USE_LOGFLARE_PG_SQL`, before this SQL is ever built. The cloud SQL
// builders below (BQ + upstream's OTEL variant) are only reachable on cloud.
function getEdgeFunctionsLastHourStatsSqlBq(functionIds: string[]): SafeLogSqlFragment {
  const functionIdFilter: SafeLogSqlFragment =
    functionIds.length > 0
      ? safeSql`  and function_id in (${joinSqlFragments(functionIds.map(analyticsLiteral), ', ')})\n`
      : safeSql``

  return safeSql`
-- edge-functions-last-hour-stats
select
  function_id,
  count(distinct id) as requests_count,
  count(distinct case when response.status_code >= 500 then id end) as server_err_count
from
  function_edge_logs
  cross join unnest(metadata) as m
  cross join unnest(m.response) as response
where
  function_id is not null
${functionIdFilter}group by
  function_id
`
}

function getEdgeFunctionsLastHourStatsSqlOtel(functionIds: string[]): SafeLogSqlFragment {
  const functionIdFilter: SafeLogSqlFragment =
    functionIds.length > 0
      ? safeSql`  and log_attributes['function_id'] in (${joinSqlFragments(functionIds.map(analyticsLiteral), ', ')})\n`
      : safeSql``

  return safeSql`
-- edge-functions-last-hour-stats
select
  log_attributes['function_id'] as function_id,
  count(distinct id) as requests_count,
  count(distinct case when toInt32OrZero(log_attributes['response.status_code']) >= 500 then id end) as server_err_count
from logs
where
  source = 'function_edge_logs'
  and log_attributes['function_id'] != ''
${functionIdFilter}group by
  function_id
`
}

function getEdgeFunctionsLastHourStatsSql(
  functionIds: string[],
  useOtel: boolean
): SafeLogSqlFragment {
  return useOtel
    ? getEdgeFunctionsLastHourStatsSqlOtel(functionIds)
    : getEdgeFunctionsLastHourStatsSqlBq(functionIds)
}

type LastHourStatsRow = {
  function_id: string
  requests_count: number | string
  server_err_count: number | string
}

// [self-platform] M6.3 fold-in: shared by both the cloud (BQ/OTEL logs.all) and
// self-hosted (functions.last-hour-stats substitute, always zero rows) code
// paths below — factored out so the substitute's honest-empty result folds
// through the exact same shape derivation as the cloud path, rather than
// duplicating it.
function toLastHourStatsResponse(rows: LastHourStatsRow[]): EdgeFunctionsLastHourStatsResponse {
  return rows.reduce<EdgeFunctionsLastHourStatsResponse>((acc, row) => {
    const toSafeNumber = (v: number | string | undefined) => {
      const n = Number(v ?? 0)
      return Number.isFinite(n) ? n : 0
    }
    const safeRequestsCount = toSafeNumber(row.requests_count)
    const safeServerErrorCount = toSafeNumber(row.server_err_count)

    acc[row.function_id] = {
      functionId: row.function_id,
      requestsCount: safeRequestsCount,
      serverErrorCount: safeServerErrorCount,
      errorRate: safeRequestsCount > 0 ? (safeServerErrorCount / safeRequestsCount) * 100 : 0,
    }

    return acc
  }, {})
}

// [self-platform] M6.3 fold-in: `functions.last-hour-stats` is a
// self-hosted-only substitute endpoint (analytics-substitutes.ts) — it has
// no entry in the generated `paths` type (api-types), so `get` (typed
// against that generated schema) can't be called against it directly.
// Narrowed via `unknown` rather than `any` to keep the call itself typed.
type SelfHostedSubstituteGet = (
  path: string,
  init: {
    params: { path: { ref: string }; query: Record<string, string> }
    signal?: AbortSignal
  }
) => Promise<{ data?: { result?: LastHourStatsRow[] }; error?: unknown }>

export async function getEdgeFunctionsLastHourStats(
  { projectRef, functionIds = [], useOtel = false }: EdgeFunctionsLastHourStatsVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')
  if (functionIds.length === 0) return {}

  if (USE_LOGFLARE_PG_SQL) {
    // [self-platform] M6.3: per-function stats are structurally underivable
    // self-hosted (function_id never populated — see the M6.2 pin above).
    // Route through the named substitute endpoint: honest empty result, no
    // categorical 500. OTEL is a cloud-only flag, so it does not apply here.
    const { data, error } = await (get as unknown as SelfHostedSubstituteGet)(
      '/platform/projects/{ref}/analytics/endpoints/functions.last-hour-stats',
      {
        params: {
          path: { ref: projectRef },
          query: { function_ids: functionIds.join(',') },
        },
        signal,
      }
    )

    if (error) handleError(error)

    return toLastHourStatsResponse(data?.result ?? [])
  }

  const endDate = dayjs().toISOString()
  const startDate = dayjs().subtract(1, 'hour').toISOString()

  const data = await executeAnalyticsSql({
    projectRef,
    endpoint: logsAllEndpointUrl(useOtel),
    sql: getEdgeFunctionsLastHourStatsSql(functionIds, useOtel),
    iso_timestamp_start: startDate,
    iso_timestamp_end: endDate,
    key: 'last-hour-stats',
    signal,
  })

  if (data?.error) handleError(data.error)

  const result = (data?.result ?? []) as LastHourStatsRow[]

  return toLastHourStatsResponse(result)
}

export type EdgeFunctionsLastHourStatsData = Awaited<
  ReturnType<typeof getEdgeFunctionsLastHourStats>
>
export type EdgeFunctionsLastHourStatsError = ResponseError

export const useEdgeFunctionsLastHourStatsQuery = <TData = EdgeFunctionsLastHourStatsData>(
  { projectRef, functionIds = [] }: EdgeFunctionsLastHourStatsVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<
    EdgeFunctionsLastHourStatsData,
    EdgeFunctionsLastHourStatsError,
    TData
  > = {}
) => {
  const useOtel = useFlag('otelLegacyLogs')

  return useQuery<EdgeFunctionsLastHourStatsData, EdgeFunctionsLastHourStatsError, TData>({
    queryKey: edgeFunctionsKeys.lastHourStats(projectRef, functionIds, useOtel),
    queryFn: ({ signal }) =>
      getEdgeFunctionsLastHourStats({ projectRef, functionIds, useOtel }, signal),
    enabled: enabled && typeof projectRef !== 'undefined' && functionIds.length > 0,
    staleTime: 60 * 1000,
    retry: false,
    ...options,
  })
}
