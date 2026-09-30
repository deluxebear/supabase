import { useQuery } from '@tanstack/react-query'
import { useFlag } from 'common'

import { executeAnalyticsSql } from './execute-analytics-sql'
import { logsKeys } from './keys'
import { USE_LOGFLARE_PG_SQL } from './logflare-dialect'
import { logsAllEndpointUrl, pickLogsQueryBuilder } from './logs-endpoint'
import {
  getUnifiedLogsISOStartEnd,
  UNIFIED_LOGS_QUERY_OPTIONS,
  UnifiedLogsVariables,
} from './unified-logs-infinite-query'
import { getLogsCountQuery } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.queries'
import { getLogsCountQuery as getLogsCountQueryBq } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.queries.bq'
import { getFacetCountQuery as getPgFacetCountQuery } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.queries.pg'
import { FacetMetadataSchema } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.schema'
import { ResponseError, UseCustomQueryOptions } from '@/types'

// Trimmed client-side because the OTEL endpoint rejects LIMIT BY, so the count
// query can't cap rows per facet in SQL.
const MAX_FACET_ROWS = 20

export async function getUnifiedLogsCount(
  { projectRef, search, useOtel = false }: UnifiedLogsVariables & { useOtel?: boolean },
  signal?: AbortSignal
) {
  if (typeof projectRef === 'undefined') {
    throw new Error('projectRef is required for getUnifiedLogsCount')
  }

  const { isoTimestampStart, isoTimestampEnd } = getUnifiedLogsISOStartEnd(search)
  const execute = (sql: Parameters<typeof executeAnalyticsSql>[0]['sql']) =>
    executeAnalyticsSql({
      projectRef,
      endpoint: logsAllEndpointUrl(useOtel),
      sql,
      iso_timestamp_start: isoTimestampStart,
      iso_timestamp_end: isoTimestampEnd,
      signal,
    })
  let data
  if (USE_LOGFLARE_PG_SQL) {
    // The PG sandbox does not support Cloud's CTE/UNION facet query.
    const results = await Promise.all(
      ['total', 'log_type', 'level', 'method', 'status', 'pathname', 'auth_user'].map((facet) =>
        execute(getPgFacetCountQuery({ search, facet }))
      )
    )
    data = { result: results.flatMap((result) => result.result ?? []) }
  } else {
    data = await execute(
      pickLogsQueryBuilder(useOtel, getLogsCountQuery, getLogsCountQueryBq)(search)
    )
  }

  const facets: Record<string, FacetMetadataSchema> = {}
  const countsByFacet: Record<string, Map<string, number>> = {}
  let totalRowCount = 0

  if (data?.result) {
    data.result.forEach((row: any) => {
      const facet = row.facet
      const value = row.value
      const count = Number(row.count || 0)

      if (facet === 'total' && value === 'all') {
        totalRowCount = count
      }

      if (!countsByFacet[facet]) {
        countsByFacet[facet] = new Map()
      }

      countsByFacet[facet].set(value, count)
    })
  }

  Object.entries(countsByFacet).forEach(([facet, countsMap]) => {
    if (facet === 'total') return

    const rows = Array.from(countsMap.entries())
      .map(([value, count]) => ({ value, total: count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, MAX_FACET_ROWS)

    const facetTotal = rows.reduce((sum, row) => sum + row.total, 0)

    facets[facet] = {
      total: facetTotal,
      rows,
    }
  })

  return { totalRowCount, facets }
}

export type UnifiedLogsCountData = Awaited<ReturnType<typeof getUnifiedLogsCount>>
export type UnifiedLogsCountError = ResponseError

export const useUnifiedLogsCountQuery = <TData = UnifiedLogsCountData>(
  { projectRef, search }: UnifiedLogsVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<UnifiedLogsCountData, UnifiedLogsCountError, TData> = {}
) => {
  const useOtel = useFlag('otelUnifiedLogs')
  return useQuery<UnifiedLogsCountData, UnifiedLogsCountError, TData>({
    queryKey: [...logsKeys.unifiedLogsCount(projectRef, search), { otel: useOtel }],
    queryFn: ({ signal }) => getUnifiedLogsCount({ projectRef, search, useOtel }, signal),
    enabled: enabled && typeof projectRef !== 'undefined',
    ...UNIFIED_LOGS_QUERY_OPTIONS,
    ...options,
  })
}
