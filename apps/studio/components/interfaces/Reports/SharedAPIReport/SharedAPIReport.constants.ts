import * as Sentry from '@sentry/nextjs'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { FeatureFlagContext, useFlag, useParams } from 'common'
import { isEqual } from 'lodash'
import { useContext, useState } from 'react'

import { generateRegexpWhereSafe, PRESET_CONFIG } from '../Reports.constants'
import { ReportFilterItem } from '../Reports.types'
import { getLogsSql } from '../Reports.utils'
import { executeAnalyticsSql } from '@/data/logs/execute-analytics-sql'
import { pickDialect } from '@/data/logs/logflare-dialect'
import { logsAllEndpointUrl } from '@/data/logs/logs-endpoint'
import { safeSql, type SafeLogSqlFragment } from '@/data/logs/safe-analytics-sql'
import { reportKeys } from '@/data/reports/keys'
import { IS_PLATFORM } from '@/lib/constants'

const SOURCE_TABLE: Record<string, SafeLogSqlFragment> = {
  edge_logs: safeSql`edge_logs`,
  function_edge_logs: safeSql`function_edge_logs`,
}

function sourceTable(src: string): SafeLogSqlFragment {
  return SOURCE_TABLE[src] ?? SOURCE_TABLE.edge_logs
}

export const SHARED_API_REPORT_SQL = {
  totalRequests: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      pickDialect(
        safeSql`
        --reports-api-total-requests
        select
          timestamp_trunc(t.timestamp, hour) as timestamp,
          count(t.id) as count
        FROM ${sourceTable(src)} t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          ${generateRegexpWhereSafe(filters)}
        GROUP BY 1
        ORDER BY 1 ASC`,
        safeSql`
        --reports-api-total-requests
        select
          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,
          count(t.id) as count
        FROM edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          ${generateRegexpWhereSafe(filters)}
        GROUP BY
          timestamp
        ORDER BY
          timestamp ASC`
      ),
  },
  topRoutes: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      pickDialect(
        safeSql`
        -- reports-api-top-routes
        select
          request.path as path,
          request.method as method,
          request.search as search,
          response.status_code as status_code,
          count(t.id) as count
        from ${sourceTable(src)} t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          ${generateRegexpWhereSafe(filters)}
        group by 1, 2, 3, 4
        order by 5 desc
        limit 10
        `,
        safeSql`
        -- reports-api-top-routes
        select
          request.path as path,
          request.method as method,
          request.search as search,
          response.status_code as status_code,
          count(t.id) as count
        from edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          ${generateRegexpWhereSafe(filters)}
        group by
          request.path, request.method, request.search, response.status_code
        order by
          count desc
        limit 10
        `
      ),
  },
  errorCounts: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      pickDialect(
        safeSql`
        -- reports-api-error-counts
        select
          timestamp_trunc(t.timestamp, hour) as timestamp,
          count(t.id) as count
        FROM ${sourceTable(src)} t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
        WHERE
          response.status_code >= 400
        ${generateRegexpWhereSafe(filters, false)}
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        safeSql`
        -- reports-api-error-counts
        select
          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,
          count(t.id) as count
        FROM edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
        WHERE
          response.status_code >= 400
        ${generateRegexpWhereSafe(filters, false)}
        GROUP BY
          timestamp
        ORDER BY
          timestamp ASC
        `
      ),
  },
  topErrorRoutes: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      pickDialect(
        safeSql`
        -- reports-api-top-error-routes
        select
          request.path as path,
          request.method as method,
          request.search as search,
          response.status_code as status_code,
          count(t.id) as count
        from ${sourceTable(src)} t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
        where
          response.status_code >= 400
        ${generateRegexpWhereSafe(filters, false)}
        group by 1, 2, 3, 4
        order by 5 desc
        limit 10
        `,
        safeSql`
        -- reports-api-top-error-routes
        select
          request.path as path,
          request.method as method,
          request.search as search,
          response.status_code as status_code,
          count(t.id) as count
        from edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
        where
          response.status_code >= 400
        ${generateRegexpWhereSafe(filters, false)}
        group by
          request.path, request.method, request.search, response.status_code
        order by
          count desc
        limit 10
        `
      ),
  },
  responseSpeed: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      pickDialect(
        // [self-platform] M6.2 T3 live-verification finding (beyond the
        // Step 1 pins): `avg(response.origin_time)` 500s — same root cause
        // as networkTraffic's content_length (self-hosted's kong_logs
        // vector transform never sets `origin_time`, so the PG translator
        // has no numeric type on file for it). Honest 0-flatline, same
        // precedent.
        safeSql`
        -- reports-api-response-speed
        select
          timestamp_trunc(t.timestamp, hour) as timestamp,
          0 as avg
        FROM
          ${sourceTable(src)} t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          ${generateRegexpWhereSafe(filters)}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
        safeSql`
        -- reports-api-response-speed
        select
          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,
          avg(response.origin_time) as avg
        FROM
          edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          ${generateRegexpWhereSafe(filters)}
        GROUP BY
          timestamp
        ORDER BY
          timestamp ASC
      `
      ),
  },
  // [self-platform] M6.2 T3 live-verification finding (beyond the Step 1
  // pins): `avg(response.origin_time)` 500s (see responseSpeed) — but
  // unlike responseSpeed (a single value-over-time line), this widget's
  // entire purpose is ranking routes BY that average; flatlining it would
  // produce a fake, arbitrarily-ordered "top 10 slow routes" with a false
  // 0ms reading, which is actively misleading rather than an honest gap. No
  // PG variant: kept as the original BQ text in both branches, surfacing
  // the existing chart error state (same category as the two
  // approx_quantiles-blocked auth percentile templates).
  topSlowRoutes: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[]): SafeLogSqlFragment =>
      safeSql`
        -- reports-api-top-slow-routes
        select
          request.path as path,
          request.method as method,
          request.search as search,
          response.status_code as status_code,
          count(t.id) as count,
          avg(response.origin_time) as avg
        from edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
        ${generateRegexpWhereSafe(filters)}
        group by
          request.path, request.method, request.search, response.status_code
        order by
          avg desc
        limit 10
        `,
  },
  networkTraffic: {
    queryType: 'logs',
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      pickDialect(
        // [self-platform] M6.2 T3 Step 1 pin: `safe_divide` 500s on the
        // Logflare PG translator (int64 cast + plain division works, but
        // `content_length` is never populated on self-hosted request/response
        // headers — 0/102 sampled rows — so the real formula would flatline
        // to 0 anyway; an honest static flatline avoids depending on a
        // broken builtin for no behavioral gain).
        safeSql`
        -- reports-api-network-traffic
        select
          timestamp_trunc(t.timestamp, hour) as timestamp,
          0 as ingress_mb,
          0 as egress_mb
        FROM
          ${sourceTable(src)} t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          cross join unnest(response.headers) as resp_headers
          ${generateRegexpWhereSafe(filters)}
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        safeSql`
        -- reports-api-network-traffic
        select
          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,
          coalesce(
            safe_divide(
              sum(
                cast(coalesce(headers.content_length, "0") as int64)
              ),
              1000000
            ),
            0
          ) as ingress_mb,
          coalesce(
            safe_divide(
              sum(
                cast(coalesce(resp_headers.content_length, "0") as int64)
              ),
              1000000
            ),
            0
          ) as egress_mb,
        FROM
          edge_logs t
          cross join unnest(metadata) as m
          cross join unnest(m.response) as response
          cross join unnest(m.request) as request
          cross join unnest(request.headers) as headers
          cross join unnest(response.headers) as resp_headers
          ${generateRegexpWhereSafe(filters)}
        GROUP BY
          timestamp
        ORDER BY
          timestamp ASC
        `
      ),
  },
}

export type SharedAPIReportKey = keyof typeof SHARED_API_REPORT_SQL

export type SharedAPIReportFilterBy = 'auth' | 'realtime' | 'postgrest'

type SharedAPIReportParams = {
  filterBy: SharedAPIReportFilterBy
  start: string
  end: string
  projectRef: string
  enabled?: boolean
}
export const useSharedAPIReport = ({
  filterBy,
  start,
  end,
  enabled = true,
}: Omit<SharedAPIReportParams, 'projectRef'>) => {
  const { ref } = useParams() as { ref: string }
  const [filters, setFilters] = useState<ReportFilterItem[]>([])
  const queryClient = useQueryClient()
  const flagUseOtel = useFlag('otelReports')
  const { hasLoaded: hasLoadedFlags } = useContext(FeatureFlagContext)
  const filterByMapValue: Record<SharedAPIReportFilterBy, string> = {
    realtime: '/realtime',
    postgrest: '/rest',
    auth: '/auth',
  }

  const baseFilter = {
    key: 'request.path',
    value: filterByMapValue[filterBy],
    compare: 'matches' as const,
  }

  const allFilters = [baseFilter, ...filters]
  const source = 'edge_logs'
  const useOtel = IS_PLATFORM && Boolean(flagUseOtel)
  const isQueryModeReady = !IS_PLATFORM || hasLoadedFlags === true
  const keys = Object.keys(SHARED_API_REPORT_SQL) as SharedAPIReportKey[]
  const getQuerySql = (queryName: SharedAPIReportKey) =>
    useOtel
      ? getLogsSql(PRESET_CONFIG.api.queries[queryName], allFilters, true)
      : SHARED_API_REPORT_SQL[queryName].safeSql(allFilters)
  const SQLMap: Record<SharedAPIReportKey, SafeLogSqlFragment> = {
    totalRequests: getQuerySql('totalRequests'),
    topRoutes: getQuerySql('topRoutes'),
    errorCounts: getQuerySql('errorCounts'),
    topErrorRoutes: getQuerySql('topErrorRoutes'),
    responseSpeed: getQuerySql('responseSpeed'),
    topSlowRoutes: getQuerySql('topSlowRoutes'),
    networkTraffic: getQuerySql('networkTraffic'),
  }

  const queries = useQueries({
    queries: keys.map((queryName) => ({
      queryKey: reportKeys.sharedApiMetric({
        filterBy,
        queryName,
        source,
        filters,
        start,
        end,
        projectRef: ref,
        useOtel,
      }),
      enabled: enabled && isQueryModeReady && !!ref && !!filterBy,
      queryFn: async ({ signal }) => {
        try {
          const data = await executeAnalyticsSql({
            projectRef: ref,
            endpoint: logsAllEndpointUrl(useOtel),
            sql: SQLMap[queryName],
            iso_timestamp_start: start,
            iso_timestamp_end: end,
            method: 'get',
            signal,
          })
          if (data?.error !== undefined) {
            const message = typeof data.error === 'string' ? data.error : data.error.message
            throw new Error(message)
          }
          return data
        } catch (err) {
          Sentry.captureException({ message: 'Shared API Report Error', data: { error: err } })
          throw err
        }
      },
    })),
  })

  const data = keys.reduce(
    (acc, key, i) => {
      acc[key] = queries[i].data?.result || []
      return acc
    },
    {} as { [K in keyof typeof SHARED_API_REPORT_SQL]: unknown[] }
  )

  const error = keys.reduce(
    (acc, key, i) => {
      acc[key] = queries[i].error
      return acc
    },
    {} as { [K in keyof typeof SHARED_API_REPORT_SQL]: Error | null }
  )

  const isLoading = keys.reduce(
    (acc, key, i) => {
      acc[key] = !isQueryModeReady || queries[i].isLoading
      return acc
    },
    {} as { [K in keyof typeof SHARED_API_REPORT_SQL]: boolean }
  )
  const addFilter = (filter: ReportFilterItem) => {
    if (isEqual(filter, baseFilter)) return
    if (filters.some((f) => isEqual(f, filter))) return
    setFilters((prev) =>
      [...prev, filter].sort((a, b) => {
        const keyA = a.key.toLowerCase()
        const keyB = b.key.toLowerCase()
        if (keyA < keyB) {
          return -1
        }
        if (keyA > keyB) {
          return 1
        }
        return 0
      })
    )
  }

  const removeFilters = (toRemove: ReportFilterItem[]) => {
    setFilters((prev) => prev.filter((f) => !toRemove.find((r) => isEqual(f, r))))
  }

  const isLoadingData = Object.values(isLoading).some(Boolean)

  return {
    data,
    error,
    isLoading,
    isLoadingData,
    isRefetching: queryClient.isFetching({ queryKey: reportKeys.allSharedApi }) > 0 || false,
    refetch: () => queryClient.invalidateQueries({ queryKey: reportKeys.allSharedApi }),
    filters,
    addFilter,
    removeFilters,
    /**
     * The SQL queries used to fetch each metric
     */
    sql: SQLMap,
  }
}
