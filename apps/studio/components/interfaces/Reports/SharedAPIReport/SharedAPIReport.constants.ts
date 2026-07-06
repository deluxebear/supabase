import * as Sentry from '@sentry/nextjs'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'common'
import { isEqual } from 'lodash'
import { useState } from 'react'

import { generateRegexpWhereSafe } from '../Reports.constants'
import { ReportFilterItem } from '../Reports.types'
import { executeAnalyticsSql } from '@/data/logs/execute-analytics-sql'
import { pickDialect } from '@/data/logs/logflare-dialect'
import { safeSql, type SafeLogSqlFragment } from '@/data/logs/safe-analytics-sql'

const SOURCE_TABLE: Record<string, SafeLogSqlFragment> = {
  edge_logs: safeSql`edge_logs`,
  function_edge_logs: safeSql`function_edge_logs`,
}

/** Returns a branded source table fragment, falling back to `edge_logs`. */
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
        FROM ${sourceTable(src)} t
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
        from ${sourceTable(src)} t
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
        FROM ${sourceTable(src)} t
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
        from ${sourceTable(src)} t
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
          ${sourceTable(src)} t
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
    safeSql: (filters: ReportFilterItem[], src = 'edge_logs'): SafeLogSqlFragment =>
      safeSql`
        -- reports-api-top-slow-routes
        select
          request.path as path,
          request.method as method,
          request.search as search,
          response.status_code as status_code,
          count(t.id) as count,
          avg(response.origin_time) as avg
        from ${sourceTable(src)} t
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
          ${sourceTable(src)} t
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

const DEFAULT_KEYS = ['shared-api-report']

export type SharedAPIReportFilterBy =
  | 'auth'
  | 'realtime'
  | 'storage'
  | 'graphql'
  | 'functions'
  | 'postgrest'
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
  const filterByMapSource = {
    functions: 'function_edge_logs',
    realtime: 'edge_logs',
    storage: 'edge_logs',
    graphql: 'edge_logs',
    postgrest: 'edge_logs',
    auth: 'edge_logs',
  }

  const filterByMapValue = {
    functions: '/functions',
    realtime: '/realtime',
    storage: '/storage',
    graphql: '/graphql',
    postgrest: '/rest',
    auth: '/auth',
  }

  const baseFilter = {
    key: 'request.path',
    value: filterByMapValue[filterBy],
    compare: 'matches' as const,
  }

  const allFilters = [baseFilter, ...filters]

  const queries = useQueries({
    queries: Object.entries(SHARED_API_REPORT_SQL).map(([key, value]) => ({
      queryKey: [
        ...DEFAULT_KEYS,
        filterBy,
        key,
        filterByMapSource[filterBy],
        filters,
        start,
        end,
        ref,
      ],
      enabled: enabled && !!ref && !!filterBy,
      queryFn: async () => {
        try {
          const data = await executeAnalyticsSql({
            projectRef: ref,
            endpoint: '/platform/projects/{ref}/analytics/endpoints/logs.all',
            sql: value.safeSql(allFilters, filterByMapSource[filterBy]),
            iso_timestamp_start: start,
            iso_timestamp_end: end,
            method: 'get',
          })
          if (data?.error) throw data.error
          return data
        } catch (err) {
          Sentry.captureException({ message: 'Shared API Report Error', data: { error: err } })
          throw err
        }
      },
    })),
  })

  const keys = Object.keys(SHARED_API_REPORT_SQL) as Array<keyof typeof SHARED_API_REPORT_SQL>

  const data = keys.reduce(
    (acc, key, i) => {
      acc[key] = queries[i].data?.result || []
      return acc
    },
    {} as { [K in keyof typeof SHARED_API_REPORT_SQL]: unknown[] }
  )

  const error = keys.reduce(
    (acc, key, i) => {
      acc[key] = queries[i].error as unknown as string
      return acc
    },
    {} as { [K in keyof typeof SHARED_API_REPORT_SQL]: string }
  )

  const isLoading = keys.reduce(
    (acc, key, i) => {
      acc[key] = queries[i].isLoading
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

  const SQLMap: Record<SharedAPIReportKey, SafeLogSqlFragment> = {
    totalRequests: SHARED_API_REPORT_SQL.totalRequests.safeSql(
      allFilters,
      filterByMapSource[filterBy]
    ),
    topRoutes: SHARED_API_REPORT_SQL.topRoutes.safeSql(allFilters, filterByMapSource[filterBy]),
    errorCounts: SHARED_API_REPORT_SQL.errorCounts.safeSql(allFilters, filterByMapSource[filterBy]),
    topErrorRoutes: SHARED_API_REPORT_SQL.topErrorRoutes.safeSql(
      allFilters,
      filterByMapSource[filterBy]
    ),
    responseSpeed: SHARED_API_REPORT_SQL.responseSpeed.safeSql(
      allFilters,
      filterByMapSource[filterBy]
    ),
    topSlowRoutes: SHARED_API_REPORT_SQL.topSlowRoutes.safeSql(
      allFilters,
      filterByMapSource[filterBy]
    ),
    networkTraffic: SHARED_API_REPORT_SQL.networkTraffic.safeSql(
      allFilters,
      filterByMapSource[filterBy]
    ),
  }

  return {
    data,
    error,
    isLoading,
    isLoadingData,
    isRefetching: queryClient.isFetching({ queryKey: DEFAULT_KEYS }) > 0 || false,
    refetch: () => queryClient.invalidateQueries({ queryKey: DEFAULT_KEYS }),
    filters,
    addFilter,
    removeFilters,
    /**
     * The SQL queries used to fetch each metric
     */
    sql: SQLMap,
  }
}
