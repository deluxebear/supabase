import { groupLogsFiltersByColumn, parseLogsFilterUrlParams } from './UnifiedLogs.filters'
import type { QuerySearchParamsType } from './UnifiedLogs.types'
import {
  joinSqlFragments,
  postgresAnalyticsLiteral as lit,
  safeSql,
  type SafeLogSqlFragment,
} from '@/data/logs/safe-analytics-sql'

type PgSearch = Pick<QuerySearchParamsType, 'date' | 'filter'> &
  Partial<
    Pick<
      QuerySearchParamsType,
      'user' | 'edge_auth' | 'edge_storage' | 'edge_postgrest' | 'show_connection_logs'
    >
  >

const COLUMNS: Record<string, SafeLogSqlFragment> = {
  log_type: safeSql`split_part(event_message, ' | ', 2)`,
  status: safeSql`split_part(event_message, ' | ', 3)`,
  level: safeSql`split_part(event_message, ' | ', 4)`,
  method: safeSql`split_part(event_message, ' | ', 5)`,
  pathname: safeSql`split_part(event_message, ' | ', 6)`,
  auth_user: safeSql`split_part(event_message, ' | ', 7)`,
  event_message: safeSql`event_message`,
}

// Logflare's PG sandbox does not apply the Cloud endpoint's ISO time parameters.
// Put UTC time bounds directly in every query.
const conditions = (search: PgSearch, exclude?: string) => {
  const end = search.date?.[1] ? new Date(search.date[1]).getTime() : Date.now()
  const start = search.date?.[0] ? new Date(search.date[0]).getTime() : end - 3_600_000
  const predicates = [
    safeSql`event_message LIKE 'UnifiedLog | %'`,
    safeSql`timestamp >= ${lit(new Date(start).toISOString())}`,
    safeSql`timestamp <= ${lit(new Date(end).toISOString())}`,
  ]
  const grouped = groupLogsFiltersByColumn(parseLogsFilterUrlParams(search.filter))
  if (!grouped.log_type && exclude !== 'log_type' && !search.user?.trim()) {
    predicates.push(safeSql`${COLUMNS.log_type} IN ('postgres', 'edge')`)
  }
  if (search.user?.trim())
    predicates.push(safeSql`${COLUMNS.auth_user} = ${lit(search.user.trim())}`)
  for (const [enabled, pattern] of [
    [search.edge_auth, '%/auth/%'],
    [search.edge_storage, '%/storage/%'],
    [search.edge_postgrest, '%/rest/%'],
  ] as const) {
    if (!enabled)
      predicates.push(
        safeSql`(${COLUMNS.log_type} <> 'edge' OR ${COLUMNS.pathname} NOT LIKE ${lit(pattern)})`
      )
  }
  if (!search.show_connection_logs) {
    predicates.push(
      safeSql`(${COLUMNS.log_type} <> 'postgres' OR event_message NOT ILIKE '%connection authorized%' AND event_message NOT ILIKE '%connection received%' AND event_message NOT ILIKE '%disconnection:%')`
    )
  }
  for (const [key, { operator, values }] of Object.entries(grouped)) {
    const column = COLUMNS[key]
    if (!Object.hasOwn(COLUMNS, key) || !column || key === exclude || values.length === 0) continue
    const isNegative = operator === '<>' || operator === '!~~*'
    const isSubstring = operator === '~~*' || operator === '!~~*'
    const op = isNegative ? safeSql`<>` : safeSql`=`
    const like = isNegative ? safeSql`NOT ILIKE` : safeSql`ILIKE`
    const branches = values.map((value) =>
      isSubstring
        ? safeSql`${column} ${like} ${lit(value.includes('%') ? value : `%${value}%`)}`
        : safeSql`${column} ${op} ${lit(value)}`
    )
    predicates.push(safeSql`(${joinSqlFragments(branches, isNegative ? ' AND ' : ' OR ')})`)
  }
  return joinSqlFragments(predicates, ' AND ')
}

export const getUnifiedLogsQuery = (
  search: PgSearch
): SafeLogSqlFragment => safeSql`-- self-hosted unified logs
SELECT cast(id as text) as id, timestamp, event_message,
  ${COLUMNS.log_type} as log_type,
  nullif(${COLUMNS.status}, '') as status,
  ${COLUMNS.level} as level,
  nullif(${COLUMNS.method}, '') as method,
  nullif(${COLUMNS.pathname}, '') as pathname,
  nullif(${COLUMNS.auth_user}, '') as auth_user,
  null as log_count, null as logs
FROM unified_logs WHERE ${conditions(search)}
`

export const getFacetCountQuery = ({
  search,
  facet,
  facetSearch,
}: {
  search: PgSearch
  facet: string
  facetSearch?: string
}): SafeLogSqlFragment => {
  if (facet === 'total') {
    return safeSql`-- self-hosted unified logs
SELECT 'total' as facet, 'all' as value, count(*) as count
FROM unified_logs WHERE ${conditions(search)} LIMIT 1`
  }
  const column = COLUMNS[facet]
  if (!Object.hasOwn(COLUMNS, facet) || !column || facet === 'event_message')
    throw new Error('Invalid logs facet')
  const searchCondition = facetSearch
    ? safeSql`AND ${column} ILIKE ${lit(`%${facetSearch}%`)}`
    : safeSql``
  return safeSql`-- self-hosted unified logs
SELECT ${lit(facet)} as facet, ${column} as value, count(*) as count
FROM unified_logs WHERE ${conditions(search, facet)} AND ${column} <> '' ${searchCondition}
GROUP BY value ORDER BY count DESC LIMIT 20`
}

export const getLogsChartQuery = (search: PgSearch): SafeLogSqlFragment => {
  const start = search.date?.[0] ? new Date(search.date[0]).getTime() : Date.now() - 3_600_000
  const end = search.date?.[1] ? new Date(search.date[1]).getTime() : Date.now()
  const hours = (end - start) / 3_600_000
  let unit = 'minute'
  if (hours >= 48) unit = 'day'
  else if (hours > 12) unit = 'hour'
  return safeSql`-- self-hosted unified logs
SELECT date_trunc(${lit(unit)}, timestamp) as time_bucket,
  sum(case when ${COLUMNS.level} = 'success' then 1 else 0 end) as success,
  sum(case when ${COLUMNS.level} = 'warning' then 1 else 0 end) as warning,
  sum(case when ${COLUMNS.level} = 'error' then 1 else 0 end) as error
FROM unified_logs WHERE ${conditions(search)} GROUP BY time_bucket ORDER BY time_bucket LIMIT 10000`
}

export const getUnifiedLogInspectionQuery = (
  id: string,
  start: number,
  end: number
) => safeSql`-- self-hosted unified logs
SELECT cast(id as text) as id, timestamp, event_message
FROM unified_logs WHERE cast(id as text) = ${lit(id)}
AND timestamp >= ${lit(new Date(start).toISOString())} AND timestamp <= ${lit(new Date(end).toISOString())} LIMIT 1`
