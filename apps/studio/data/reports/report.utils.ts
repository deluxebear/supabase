import { type ComparisonOperator } from '@/components/interfaces/Reports/v2/ReportsNumericFilter'
import { AnalyticsInterval } from '@/data/analytics/constants'
import { executeAnalyticsSql } from '@/data/logs/execute-analytics-sql'
import { logsAllEndpointUrl } from '@/data/logs/logs-endpoint'
import {
  postgresAnalyticsLiteral,
  safeSql,
  type SafeLogSqlFragment,
} from '@/data/logs/safe-analytics-sql'

export type Granularity = 'minute' | 'hour' | 'day'

/**
 * [self-platform] `date_trunc` units for report queries that run as native
 * Postgres on a self-hosted Logflare (SQL prefixed `-- self-hosted unified logs`,
 * routed to Logflare's `/api/query?pg_sql=` by `retrieveAnalyticsData`). That path
 * reads the real ingest sources, supports `percentile_cont`, and returns timestamps
 * as unix microseconds — unlike the `logs.all` BQ→PG translator.
 */
export const SELF_HOSTED_TRUNC_UNIT_SQL: Record<Granularity, SafeLogSqlFragment> = {
  minute: safeSql`'minute'`,
  hour: safeSql`'hour'`,
  day: safeSql`'day'`,
}

const toValidDate = (value: string, fallback: Date) => {
  const date = value ? new Date(value) : fallback
  return Number.isNaN(date.getTime()) ? fallback : date
}

/**
 * [self-platform] The native Postgres path ignores the endpoint's ISO time params,
 * so every self-hosted report query must carry its own time bounds. Defaults to
 * the last hour, matching the reports' default range.
 */
export function selfHostedTimeRangeSql(startDate: string, endDate: string): SafeLogSqlFragment {
  const end = toValidDate(endDate, new Date())
  const start = toValidDate(startDate, new Date(end.getTime() - 3_600_000))
  return safeSql`timestamp >= ${postgresAnalyticsLiteral(start.toISOString())} AND timestamp <= ${postgresAnalyticsLiteral(end.toISOString())}`
}

/**
 * Pre-branded SQL fragments for the closed set of granularity tokens that
 * `analyticsIntervalToGranularity` may return. Use to splice a granularity into
 * a `safeSql` template without re-validating at the call site.
 */
export const SAFE_GRANULARITY_SQL: Record<Granularity, SafeLogSqlFragment> = {
  minute: safeSql`minute`,
  hour: safeSql`hour`,
  day: safeSql`day`,
}

/**
 * Pre-branded SQL fragments for the closed set of numeric comparison operators
 * accepted by `ReportsNumericFilter`. Use to splice an operator into a
 * `safeSql` template without re-validating at the call site.
 */
export const SAFE_COMPARISON_OPERATOR_SQL: Record<ComparisonOperator, SafeLogSqlFragment> = {
  '=': safeSql`=`,
  '>=': safeSql`>=`,
  '<=': safeSql`<=`,
  '>': safeSql`>`,
  '<': safeSql`<`,
  '!=': safeSql`!=`,
}

export function analyticsIntervalToGranularity(interval: AnalyticsInterval): Granularity {
  switch (interval) {
    case '1m':
      return 'minute'
    case '2m':
      return 'minute'
    case '5m':
      return 'minute'
    case '10m':
      return 'minute'
    case '30m':
      return 'minute'
    case '1h':
      return 'hour'
    case '1d':
      return 'day'
    default:
      return 'hour'
  }
}

export const REPORT_STATUS_CODE_COLORS: { [key: string]: { light: string; dark: string } } = {
  '400': { light: '#FFD54F', dark: '#FFF176' },
  '401': { light: '#FF8A65', dark: '#FFAB91' },
  '403': { light: '#FFB74D', dark: '#FFCC80' },
  '404': { light: '#90A4AE', dark: '#B0BEC5' },
  '409': { light: '#BA68C8', dark: '#CE93D8' },
  '410': { light: '#A1887F', dark: '#BCAAA4' },
  '422': { light: '#FF9800', dark: '#FFB74D' },
  '429': { light: '#E65100', dark: '#F57C00' },
  '500': { light: '#B71C1C', dark: '#D32F2F' },
  '502': { light: '#9575CD', dark: '#B39DDB' },
  '503': { light: '#0097A7', dark: '#4DD0E1' },
  '504': { light: '#C0CA33', dark: '#D4E157' },
  default: { light: '#757575', dark: '#9E9E9E' },
}

export async function fetchLogs(
  projectRef: string,
  sql: SafeLogSqlFragment,
  startDate: string,
  endDate: string,
  useOtel = false
) {
  return await executeAnalyticsSql({
    projectRef,
    endpoint: logsAllEndpointUrl(useOtel),
    sql,
    iso_timestamp_start: startDate,
    iso_timestamp_end: endDate,
    method: 'get',
  })
}
