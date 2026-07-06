import { AUTH_ERROR_CODES } from 'common/constants/auth-error-codes'
import z from 'zod'

import { ReportConfig, ReportDataProviderAttribute } from './reports.types'
import {
  extractStatusCodesFromData,
  generateStatusCodeAttributes,
  transformCategoricalCountData,
  transformStatusCodeData,
} from '@/components/interfaces/Reports/Reports.utils'
import { NumericFilter } from '@/components/interfaces/Reports/v2/ReportsNumericFilter'
import type { AnalyticsInterval } from '@/data/analytics/constants'
import { pickDialect } from '@/data/logs/logflare-dialect'
import {
  analyticsLiteral,
  joinSqlFragments,
  safeSql,
  type SafeLogSqlFragment,
} from '@/data/logs/safe-analytics-sql'
import {
  analyticsIntervalToGranularity,
  fetchLogs,
  SAFE_COMPARISON_OPERATOR_SQL,
  SAFE_GRANULARITY_SQL,
} from '@/data/reports/report.utils'

const AUTH_ERROR_CODE_LIST = Object.entries(AUTH_ERROR_CODES).map(([key, value]) => ({
  key,
  description: value.description,
}))

const METRIC_KEYS = [
  'ActiveUsers',
  'SignInAttempts',
  'PasswordResetRequests',
  'TotalSignUps',
  'SignInProcessingTimeBasic',
  'SignInProcessingTimePercentiles',
  'SignUpProcessingTimeBasic',
  'SignUpProcessingTimePercentiles',
  'ErrorsByStatus',
  'ErrorsByAuthCode',
]

type MetricKey = (typeof METRIC_KEYS)[number]

type AuthReportFilters = {
  status_code?: NumericFilter | null
  provider?: string[] | null
}

// Static SELECT-clause fragment for the `auth_logs` table.
//
// [self-platform] M6.2 T3 live-verification finding (beyond the Step 1
// pins): the Logflare PG translator parses a DOUBLE-quoted JSON_VALUE path
// argument as a quoted PG *identifier*, not a string literal (standard SQL:
// `"..."` = identifier, `'...'` = string) — so `"$.provider"` 500s while
// `'$.provider'` succeeds. `json_value` the function is fine (T2's pin
// holds); the double-quote convention BigQuery also happens to accept is
// the actual break. PG branch uses single quotes; BQ text is untouched.
const PROVIDER_SELECT_FRAGMENT = pickDialect(
  safeSql`COALESCE(JSON_VALUE(event_message, '$.provider'), 'unknown') as provider,`,
  safeSql`COALESCE(JSON_VALUE(event_message, "$.provider"), 'unknown') as provider,`
)

// Static SELECT-clause fragment for the aliased `auth_logs f` form.
const PROVIDER_SELECT_FRAGMENT_F_ALIAS = pickDialect(
  safeSql`COALESCE(JSON_VALUE(f.event_message, '$.provider'), 'unknown') as provider,`,
  safeSql`COALESCE(JSON_VALUE(f.event_message, "$.provider"), 'unknown') as provider,`
)

const PROVIDER_GROUP_BY_FRAGMENT = safeSql`, provider`
const EMPTY = safeSql``

function providerSelectFragment(groupByProvider: boolean, aliased: boolean): SafeLogSqlFragment {
  if (!groupByProvider) return EMPTY
  return aliased ? PROVIDER_SELECT_FRAGMENT_F_ALIAS : PROVIDER_SELECT_FRAGMENT
}

function providerGroupBy(groupByProvider: boolean): SafeLogSqlFragment {
  return groupByProvider ? PROVIDER_GROUP_BY_FRAGMENT : EMPTY
}

/**
 * [self-platform] M6.2 T3 — ordinal tail for the PG-dialect variants of the
 * auth-usage templates. `timestamp_trunc(timestamp, …) as timestamp` shadows
 * the raw `timestamp` column, and the Logflare PG translator silently groups
 * by the RAW column when a `GROUP BY`/`ORDER BY` names a shadowed alias —
 * ordinals are mandatory (see logflare-dialect.ts).
 *
 * Returns the comma-prefixed ordinal tail that follows the `1` (timestamp)
 * in both the `GROUP BY` and `ORDER BY` clauses of these templates — those
 * two clauses append the exact same trailing column list in the original
 * BigQuery text (`${providerGroupBy(groupByProvider)}`, optionally preceded
 * by `extra`, e.g. `login_type_provider` for SignInAttempts), so one helper
 * serves both call sites. `extra` are ordinal positions already adjusted by
 * the caller for whether `groupByProvider` shifts them (e.g. SignInAttempts'
 * `login_type_provider` is position 2 without a provider column, 3 with
 * one — the caller passes the correct value per flag).
 */
function pgOrdinals(groupByProvider: boolean, extra: number[] = []): SafeLogSqlFragment {
  const tail = [...extra, ...(groupByProvider ? [2] : [])]
  if (tail.length === 0) return EMPTY
  return safeSql`, ${joinSqlFragments(
    tail.map((n) => analyticsLiteral(n)),
    ', '
  )}`
}

/**
 * Builds an `AND`-prefixed predicate fragment for `auth_logs`-shaped queries.
 * Returns the empty fragment when no filters apply. The returned value can be
 * spliced directly after a query's existing `WHERE` clause.
 */
function authFiltersToAndPredicates(filters?: AuthReportFilters): SafeLogSqlFragment {
  const predicates: SafeLogSqlFragment[] = []

  if (filters?.status_code) {
    const op = SAFE_COMPARISON_OPERATOR_SQL[filters.status_code.operator]
    predicates.push(
      safeSql`response.status_code ${op} ${analyticsLiteral(filters.status_code.value)}`
    )
  }

  if (filters?.provider && filters.provider.length > 0) {
    const list = joinSqlFragments(filters.provider.map(analyticsLiteral), ', ')
    // [self-platform] M6.2 T3: double-quoted JSON_VALUE path parses as a PG
    // identifier on the Logflare translator — see PROVIDER_SELECT_FRAGMENT.
    predicates.push(
      pickDialect(
        safeSql`JSON_VALUE(event_message, '$.provider') IN (${list})`,
        safeSql`JSON_VALUE(event_message, "$.provider") IN (${list})`
      )
    )
  }

  if (predicates.length === 0) return EMPTY
  return safeSql`AND ${joinSqlFragments(predicates, ' AND ')}`
}

/**
 * Builds an `AND`-prefixed predicate fragment for `edge_logs`-shaped queries.
 */
function edgeLogsFiltersToAndPredicates(filters?: AuthReportFilters): SafeLogSqlFragment {
  const predicates: SafeLogSqlFragment[] = []

  if (filters?.status_code) {
    const op = SAFE_COMPARISON_OPERATOR_SQL[filters.status_code.operator]
    predicates.push(
      safeSql`response.status_code ${op} ${analyticsLiteral(filters.status_code.value)}`
    )
  }

  if (predicates.length === 0) return EMPTY
  return safeSql`AND ${joinSqlFragments(predicates, ' AND ')}`
}

// Exported (not just internal) so the M6.2 T3 dialect variants can be
// snapshot-tested directly against their PG/BQ twins.
export const AUTH_REPORT_SQL: Record<
  MetricKey,
  (interval: AnalyticsInterval, filters?: AuthReportFilters) => SafeLogSqlFragment
> = {
  ActiveUsers: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return pickDialect(
      safeSql`
        --active-users
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, true)}
          count(distinct json_value(f.event_message, '$.auth_event.actor_id')) as count
        from auth_logs f
        where json_value(f.event_message, '$.auth_event.action') in (
          'login', 'user_signedup', 'token_refreshed', 'user_modified',
          'user_recovery_requested', 'user_reauthenticate_requested'
        )
        ${andPredicates}
        group by 1${pgOrdinals(groupByProvider)}
        order by 1 desc${pgOrdinals(groupByProvider)}
      `,
      safeSql`
        --active-users
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, true)}
          count(distinct json_value(f.event_message, "$.auth_event.actor_id")) as count
        from auth_logs f
        where json_value(f.event_message, "$.auth_event.action") in (
          'login', 'user_signedup', 'token_refreshed', 'user_modified',
          'user_recovery_requested', 'user_reauthenticate_requested'
        )
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
    )
  },
  SignInAttempts: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    // login_type_provider sits at select position 2 without a provider
    // column, 3 with one (the provider column, when present, is inserted
    // right after timestamp — see providerSelectFragment).
    const loginTypeProviderPosition = groupByProvider ? [3] : [2]
    return pickDialect(
      safeSql`
        --sign-in-attempts
        SELECT
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          CASE
            WHEN JSON_VALUE(event_message, '$.provider') IS NOT NULL
                AND JSON_VALUE(event_message, '$.provider') != ''
            THEN CONCAT(
              JSON_VALUE(event_message, '$.login_method'),
              ' (',
              JSON_VALUE(event_message, '$.provider'),
              ')'
            )
            ELSE JSON_VALUE(event_message, '$.login_method')
          END as login_type_provider,
          COUNT(*) as count
        FROM
          auth_logs
        WHERE
          JSON_VALUE(event_message, '$.action') = 'login'
          AND JSON_VALUE(event_message, '$.metering') = 'true'
          ${andPredicates}
        GROUP BY
          1${pgOrdinals(groupByProvider, loginTypeProviderPosition)}
        ORDER BY
          1 desc${pgOrdinals(groupByProvider, loginTypeProviderPosition)}
      `,
      safeSql`
        --sign-in-attempts
        SELECT
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          CASE
            WHEN JSON_VALUE(event_message, "$.provider") IS NOT NULL
                AND JSON_VALUE(event_message, "$.provider") != ''
            THEN CONCAT(
              JSON_VALUE(event_message, "$.login_method"),
              ' (',
              JSON_VALUE(event_message, "$.provider"),
              ')'
            )
            ELSE JSON_VALUE(event_message, "$.login_method")
          END as login_type_provider,
          COUNT(*) as count
        FROM
          auth_logs
        WHERE
          JSON_VALUE(event_message, "$.action") = 'login'
          AND JSON_VALUE(event_message, "$.metering") = "true"
          ${andPredicates}
        GROUP BY
          timestamp, login_type_provider${providerGroupBy(groupByProvider)}
        ORDER BY
          timestamp desc, login_type_provider${providerGroupBy(groupByProvider)}
      `
    )
  },
  PasswordResetRequests: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return pickDialect(
      safeSql`
        --password-reset-requests
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, true)}
          count(*) as count
        from auth_logs f
        where json_value(f.event_message, '$.auth_event.action') = 'user_recovery_requested'
        ${andPredicates}
        group by 1${pgOrdinals(groupByProvider)}
        order by 1 desc${pgOrdinals(groupByProvider)}
      `,
      safeSql`
        --password-reset-requests
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, true)}
          count(*) as count
        from auth_logs f
        where json_value(f.event_message, "$.auth_event.action") = 'user_recovery_requested'
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
    )
  },
  TotalSignUps: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return pickDialect(
      safeSql`
        --total-signups
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count
        from auth_logs
        where json_value(event_message, '$.auth_event.action') = 'user_signedup'
        ${andPredicates}
        group by 1${pgOrdinals(groupByProvider)}
        order by 1 desc${pgOrdinals(groupByProvider)}
      `,
      safeSql`
        --total-signups
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count
        from auth_logs
        where json_value(event_message, "$.auth_event.action") = 'user_signedup'
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
    )
  },
  SignInProcessingTimeBasic: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return pickDialect(
      safeSql`
        --signin-processing-time-basic
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count,
          round(avg(cast(json_value(event_message, '$.duration') as int64)) / 1000000, 2) as avg_processing_time_ms,
          round(min(cast(json_value(event_message, '$.duration') as int64)) / 1000000, 2) as min_processing_time_ms,
          round(max(cast(json_value(event_message, '$.duration') as int64)) / 1000000, 2) as max_processing_time_ms
        from auth_logs
        where json_value(event_message, '$.auth_event.action') = 'login'
        ${andPredicates}
        group by 1${pgOrdinals(groupByProvider)}
        order by 1 desc${pgOrdinals(groupByProvider)}
      `,
      safeSql`
        --signin-processing-time-basic
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count,
          round(avg(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as avg_processing_time_ms,
          round(min(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as min_processing_time_ms,
          round(max(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as max_processing_time_ms
        from auth_logs
        where json_value(event_message, "$.auth_event.action") = 'login'
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
    )
  },
  // [self-platform] M6.2 T3 Step 1 pin: `approx_quantiles(...)[offset(n)]`
  // 500s on the Logflare PG translator. No PG variant is implemented here —
  // per the brief's decision rule, this template keeps the BQ text in BOTH
  // branches (no pickDialect gate) and surfaces the existing chart error
  // state on a stock Logflare PG backend; documented as a known limitation.
  SignInProcessingTimePercentiles: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return safeSql`
        --signin-processing-time-percentiles
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count,
          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(50)] / 1000000, 2) as p50_processing_time_ms,
          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(95)] / 1000000, 2) as p95_processing_time_ms,
          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(99)] / 1000000, 2) as p99_processing_time_ms
        from auth_logs
        where json_value(event_message, "$.auth_event.action") = 'login'
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
  },
  SignUpProcessingTimeBasic: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return pickDialect(
      safeSql`
        --signup-processing-time-basic
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count,
          round(avg(cast(json_value(event_message, '$.duration') as int64)) / 1000000, 2) as avg_processing_time_ms,
          round(min(cast(json_value(event_message, '$.duration') as int64)) / 1000000, 2) as min_processing_time_ms,
          round(max(cast(json_value(event_message, '$.duration') as int64)) / 1000000, 2) as max_processing_time_ms
        from auth_logs
        where json_value(event_message, '$.auth_event.action') = 'user_signedup'
        ${andPredicates}
        group by 1${pgOrdinals(groupByProvider)}
        order by 1 desc${pgOrdinals(groupByProvider)}
      `,
      safeSql`
        --signup-processing-time-basic
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count,
          round(avg(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as avg_processing_time_ms,
          round(min(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as min_processing_time_ms,
          round(max(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as max_processing_time_ms
        from auth_logs
        where json_value(event_message, "$.auth_event.action") = 'user_signedup'
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
    )
  },
  // [self-platform] M6.2 T3 Step 1 pin: `approx_quantiles(...)[offset(n)]`
  // 500s on the Logflare PG translator. No PG variant is implemented here —
  // per the brief's decision rule, this template keeps the BQ text in BOTH
  // branches (no pickDialect gate) and surfaces the existing chart error
  // state on a stock Logflare PG backend; documented as a known limitation.
  SignUpProcessingTimePercentiles: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = authFiltersToAndPredicates(filters)
    const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)
    return safeSql`
        --signup-processing-time-percentiles
        select
          timestamp_trunc(timestamp, ${granularity}) as timestamp,
          ${providerSelectFragment(groupByProvider, false)}
          count(*) as count,
          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(50)] / 1000000, 2) as p50_processing_time_ms,
          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(95)] / 1000000, 2) as p95_processing_time_ms,
          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(99)] / 1000000, 2) as p99_processing_time_ms
        from auth_logs
        where json_value(event_message, "$.auth_event.action") = 'user_signedup'
        ${andPredicates}
        group by timestamp${providerGroupBy(groupByProvider)}
        order by timestamp desc${providerGroupBy(groupByProvider)}
      `
  },
  // [self-platform] M6.2 T3 live-verification finding (beyond the Step 1
  // pins): the bare top-level `path` column 500s on `edge_logs` (categorical
  // — same root cause as `function_id` on `function_edge_logs`: self-hosted's
  // kong_logs vector transform only ever sets `.metadata.request.path`, so
  // the top-level convenience alias real BigQuery has has no type on file
  // here). Swapped for the already-unnested `request.path` — same predicate,
  // populated field; every other template in this task already uses
  // `request.path`, never bare `path`.
  ErrorsByStatus: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = edgeLogsFiltersToAndPredicates(filters)
    return pickDialect(
      safeSql`
        --auth-errors-by-status
  select
    timestamp_trunc(timestamp, ${granularity}) as timestamp,
    count(*) as count,
    response.status_code
  from edge_logs
    cross join unnest(metadata) as m
    cross join unnest(m.request) as request
    cross join unnest(m.response) as response
    cross join unnest(response.headers) as h
  where request.path like '%auth/v1%'
    and response.status_code >= 400 and response.status_code <= 599
    ${andPredicates}
  group by 1, 3
  order by 1 desc
      `,
      safeSql`
        --auth-errors-by-status
  select
    timestamp_trunc(timestamp, ${granularity}) as timestamp,
    count(*) as count,
    response.status_code
  from edge_logs
    cross join unnest(metadata) as m
    cross join unnest(m.request) as request
    cross join unnest(m.response) as response
    cross join unnest(response.headers) as h
  where path like '%auth/v1%'
    and response.status_code >= 400 and response.status_code <= 599
    ${andPredicates}
  group by timestamp, status_code
  order by timestamp desc
      `
    )
  },
  // [self-platform] M6.2 T3 live-verification finding (beyond the Step 1
  // pins): same bare `path` issue as ErrorsByStatus — swapped for
  // `request.path`.
  ErrorsByAuthCode: (interval, filters) => {
    const granularity = SAFE_GRANULARITY_SQL[analyticsIntervalToGranularity(interval)]
    const andPredicates = edgeLogsFiltersToAndPredicates(filters)
    return pickDialect(
      safeSql`
        --auth-errors-by-code
  select
    timestamp_trunc(timestamp, ${granularity}) as timestamp,
    count(*) as count,
    h.x_sb_error_code as error_code
  from edge_logs
    cross join unnest(metadata) as m
    cross join unnest(m.request) as request
    cross join unnest(m.response) as response
    cross join unnest(response.headers) as h
  where request.path like '%auth/v1%'
    and response.status_code >= 400 and response.status_code <= 599
    ${andPredicates}
  group by 1, 3
  order by 1 desc
      `,
      safeSql`
        --auth-errors-by-code
  select
    timestamp_trunc(timestamp, ${granularity}) as timestamp,
    count(*) as count,
    h.x_sb_error_code as error_code
  from edge_logs
    cross join unnest(metadata) as m
    cross join unnest(m.request) as request
    cross join unnest(m.response) as response
    cross join unnest(response.headers) as h
  where path like '%auth/v1%'
    and response.status_code >= 400 and response.status_code <= 599
    ${andPredicates}
  group by timestamp, error_code
  order by timestamp desc
      `
    )
  },
}

export const AUTH_ERROR_CODE_VALUES: string[] = [
  'anonymous_provider_disabled',
  'bad_code_verifier',
  'bad_json',
  'bad_jwt',
  'bad_oauth_callback',
  'bad_oauth_state',
  'captcha_failed',
  'conflict',
  'email_address_invalid',
  'email_address_not_authorized',
  'email_conflict_identity_not_deletable',
  'email_exists',
  'email_not_confirmed',
  'email_provider_disabled',
  'flow_state_expired',
  'flow_state_not_found',
  'hook_payload_invalid_content_type',
  'hook_payload_over_size_limit',
  'hook_timeout',
  'hook_timeout_after_retry',
  'identity_already_exists',
  'identity_not_found',
  'insufficient_aal',
  'invalid_credentials',
  'invite_not_found',
  'manual_linking_disabled',
  'mfa_challenge_expired',
  'mfa_factor_name_conflict',
  'mfa_factor_not_found',
  'mfa_ip_address_mismatch',
  'mfa_phone_enroll_not_enabled',
  'mfa_phone_verify_not_enabled',
  'mfa_totp_enroll_not_enabled',
  'mfa_totp_verify_not_enabled',
  'mfa_verification_failed',
  'mfa_verification_rejected',
  'mfa_verified_factor_exists',
  'mfa_web_authn_enroll_not_enabled',
  'mfa_web_authn_verify_not_enabled',
  'no_authorization',
  'not_admin',
  'oauth_provider_not_supported',
  'otp_disabled',
  'otp_expired',
  'over_email_send_rate_limit',
  'over_request_rate_limit',
  'over_sms_send_rate_limit',
  'phone_exists',
  'phone_not_confirmed',
  'phone_provider_disabled',
  'provider_disabled',
  'provider_email_needs_verification',
  'reauthentication_needed',
  'reauthentication_not_valid',
  'refresh_token_already_used',
  'refresh_token_not_found',
  'request_timeout',
  'same_password',
  'saml_assertion_no_email',
  'saml_assertion_no_user_id',
  'saml_entity_id_mismatch',
  'saml_idp_already_exists',
  'saml_idp_not_found',
  'saml_metadata_fetch_failed',
  'saml_provider_disabled',
  'saml_relay_state_expired',
  'saml_relay_state_not_found',
  'session_expired',
  'session_not_found',
  'signup_disabled',
  'single_identity_not_deletable',
  'sms_send_failed',
  'sso_domain_already_exists',
  'sso_provider_not_found',
  'too_many_enrolled_mfa_factors',
  'unexpected_audience',
  'unexpected_failure',
  'user_already_exists',
  'user_banned',
  'user_not_found',
  'user_sso_managed',
  'validation_failed',
  'weak_password',
]

/**
 * Transforms raw analytics data into a chart-ready format by ensuring data consistency and completeness.
 *
 * This function addresses several key requirements for chart rendering:
 * 1. Fills missing timestamps with zero values to prevent gaps in charts
 * 2. Creates a consistent data structure with `period_start` as the time axis
 * 3. Initializes all chart attributes to 0, then populates actual values
 * 4. Sorts timestamps chronologically for proper chart ordering
 *
 * @param rawData - Raw analytics data from backend queries containing timestamp and count fields
 * @param attributes - Chart attribute configuration defining what metrics to display
 * @returns Formatted data object with consistent time series data and chart attributes
 */
export function defaultAuthReportFormatter(
  rawData: unknown,
  attributes: ReportDataProviderAttribute[],
  groupByProvider = false
) {
  const chartAttributes = attributes

  const rawDataSchema = z.object({
    result: z.array(
      z
        .object({
          timestamp: z.coerce.number(),
        })
        .catchall(z.any())
    ),
  })

  const parsedRawData = rawDataSchema.parse(rawData)
  const result = parsedRawData.result

  if (!result) return { data: undefined, chartAttributes }

  if (groupByProvider) {
    // Group by provider - create separate attributes for each provider
    const providers = new Set<string>()
    result.forEach((p: any) => {
      if (p.provider) {
        providers.add(p.provider)
      }
    })

    const providerAttributes: ReportDataProviderAttribute[] = []
    providers.forEach((provider) => {
      chartAttributes.forEach((attr) => {
        providerAttributes.push({
          ...attr,
          attribute: `${attr.attribute}_${provider}`,
          label: `${attr.label} (${provider})`,
        })
      })
    })

    const timestamps = new Set<string>(result.map((p: any) => String(p.timestamp)))
    const data = Array.from(timestamps)
      .sort()
      .map((timestamp) => {
        const point: any = { timestamp }
        providerAttributes.forEach((attr) => {
          point[attr.attribute] = 0
        })
        const matchingPoints = result.filter((p: any) => String(p.timestamp) === timestamp)

        matchingPoints.forEach((p: any) => {
          providerAttributes.forEach((attr) => {
            const baseAttribute = attr.attribute.split('_').slice(0, -1).join('_')
            const provider = attr.attribute.split('_').slice(-1)[0]

            if (p.provider !== provider) return

            const valueFromField =
              typeof p[baseAttribute] === 'number'
                ? p[baseAttribute]
                : typeof p.count === 'number'
                  ? p.count
                  : undefined

            if (typeof valueFromField === 'number') {
              point[attr.attribute] = (point[attr.attribute] ?? 0) + valueFromField
            }
          })
        })
        return point
      })
    return { data, chartAttributes: providerAttributes }
  } else {
    // Original logic for non-provider grouping
    const timestamps = new Set<string>(result.map((p: any) => String(p.timestamp)))
    const data = Array.from(timestamps)
      .sort()
      .map((timestamp) => {
        const point: any = { timestamp }
        chartAttributes.forEach((attr) => {
          point[attr.attribute] = 0
        })
        const matchingPoints = result.filter((p: any) => String(p.timestamp) === timestamp)

        matchingPoints.forEach((p: any) => {
          chartAttributes.forEach((attr) => {
            // Optional dimension filters used by some reports
            if ('login_type_provider' in (attr as any)) {
              if (p.login_type_provider !== (attr as any).login_type_provider) return
            }
            if ('providerType' in (attr as any)) {
              if (p.provider !== (attr as any).providerType) return
            }

            const valueFromField =
              typeof p[attr.attribute] === 'number'
                ? p[attr.attribute]
                : typeof p.count === 'number'
                  ? p.count
                  : undefined

            if (typeof valueFromField === 'number') {
              point[attr.attribute] = (point[attr.attribute] ?? 0) + valueFromField
            }
          })
        })
        return point
      })
    return { data, chartAttributes }
  }
}

export const createUsageReportConfig = ({
  projectRef,
  startDate,
  endDate,
  interval,
  filters,
}: {
  projectRef: string
  startDate: string
  endDate: string
  interval: AnalyticsInterval
  filters: AuthReportFilters
}): ReportConfig<AuthReportFilters>[] => {
  const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)

  return [
    {
      id: 'active-user',
      label: 'Auth Activity', // https://supabase.slack.com/archives/C08N7894QTG/p1761210058358439?thread_ts=1761147906.491599&cid=C08N7894QTG
      valuePrecision: 0,
      hide: false,
      showTooltip: true,
      showLegend: false,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip:
        "Users who generated any Auth event in this period. This metric tracks authentication activity, not total product usage. Some active users won't appear here if their session stayed valid.",
      dataProvider: async () => {
        const attributes = [
          { attribute: 'ActiveUsers', provider: 'logs', label: 'Auth Activity', enabled: true },
        ]

        const sql = AUTH_REPORT_SQL.ActiveUsers(interval, filters)

        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)

        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
    {
      id: 'sign-in-attempts',
      label: 'Sign In Attempts by Type',
      valuePrecision: 0,
      hide: false,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip: 'The total number of sign in attempts by type.',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'SignInAttempts',
            provider: 'logs',
            label: 'Password',
            login_type_provider: 'password',
            enabled: true,
          },
          {
            attribute: 'SignInAttempts',
            provider: 'logs',
            label: 'PKCE',
            login_type_provider: 'pkce',
            enabled: true,
          },
          {
            attribute: 'SignInAttempts',
            provider: 'logs',
            label: 'Refresh Token',
            login_type_provider: 'token',
            enabled: true,
          },
          {
            attribute: 'SignInAttempts',
            provider: 'logs',
            label: 'ID Token',
            login_type_provider: 'id_token',
            enabled: true,
          },
        ]

        const sql = AUTH_REPORT_SQL.SignInAttempts(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
    {
      id: 'signups',
      label: 'Sign Ups',
      valuePrecision: 0,
      hide: false,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip: 'The total number of sign ups.',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'TotalSignUps',
            provider: 'logs',
            label: 'Sign Ups',
            enabled: true,
          },
        ]

        const sql = AUTH_REPORT_SQL.TotalSignUps(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
    {
      id: 'password-reset-requests',
      label: 'Password Reset Requests',
      valuePrecision: 0,
      hide: false,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip: 'The total number of password reset requests.',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'PasswordResetRequests',
            provider: 'logs',
            label: 'Password Reset Requests',
            enabled: true,
          },
        ]

        const sql = AUTH_REPORT_SQL.PasswordResetRequests(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
  ]
}

export const createErrorsReportConfig = ({
  projectRef,
  startDate,
  endDate,
  interval,
  filters,
}: {
  projectRef: string
  startDate: string
  endDate: string
  interval: AnalyticsInterval
  filters: AuthReportFilters
}): ReportConfig<AuthReportFilters>[] => [
  {
    id: 'auth-errors',
    label: 'API Gateway Auth Errors',
    valuePrecision: 0,
    hide: false,
    showTooltip: true,
    showLegend: true,
    showMaxValue: false,
    hideChartType: false,
    defaultChartStyle: 'line',
    titleTooltip: 'The total number of auth errors by status code from the API Gateway.',
    dataProvider: async () => {
      const sql = AUTH_REPORT_SQL.ErrorsByStatus(interval, filters)
      const rawData = await fetchLogs(projectRef, sql, startDate, endDate)

      if (!rawData?.result) return { data: [] }

      const statusCodes = extractStatusCodesFromData(rawData.result)
      const attributes = generateStatusCodeAttributes(statusCodes)
      const data = transformStatusCodeData(rawData.result, statusCodes)

      return { data, attributes, query: sql }
    },
  },
  {
    id: 'auth-errors-by-code',
    label: 'Auth Errors by Code',
    valuePrecision: 0,
    hide: false,
    showTooltip: true,
    showLegend: true,
    showMaxValue: false,
    hideChartType: false,
    defaultChartStyle: 'line',
    titleTooltip:
      'The total number of auth errors by Supabase Auth error code from the API Gateway.',
    dataProvider: async () => {
      const sql = AUTH_REPORT_SQL.ErrorsByAuthCode(interval, filters)
      const rawData = await fetchLogs(projectRef, sql, startDate, endDate)

      if (!rawData?.result) return { data: [] }

      const categories = rawData.result
        .map((r: any) => r.error_code)
        .filter((v: any) => v !== null && v !== undefined)
      const distinct = Array.from(new Set(categories)).sort()

      const attributes = distinct.map((c: string) => ({
        attribute: c,
        label: c,
        tooltip: AUTH_ERROR_CODE_LIST.find((e) => e.key === c)?.description,
      }))

      const pivoted = transformCategoricalCountData(rawData.result, 'error_code', distinct)

      return { data: pivoted, attributes, query: sql }
    },
  },
]

export const createLatencyReportConfig = ({
  projectRef,
  startDate,
  endDate,
  interval,
  filters,
}: {
  projectRef: string
  startDate: string
  endDate: string
  interval: AnalyticsInterval
  filters: AuthReportFilters
}): ReportConfig<AuthReportFilters>[] => {
  const groupByProvider = Boolean(filters?.provider && filters.provider.length > 0)

  return [
    {
      id: 'sign-in-processing-time-basic',
      label: 'Sign In Processing Time',
      valuePrecision: 2,
      hide: false,
      hideHighlightedValue: true,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip:
        'Basic processing time metrics for sign in operations within the auth server (excludes network latency).',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'avg_processing_time_ms',
            label: 'Avg. Processing Time (ms)',
          },
          {
            attribute: 'min_processing_time_ms',
            label: 'Min. Processing Time (ms)',
          },
          {
            attribute: 'max_processing_time_ms',
            label: 'Max. Processing Time (ms)',
          },
        ]

        const sql = AUTH_REPORT_SQL.SignInProcessingTimeBasic(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
    {
      id: 'sign-in-processing-time-percentiles',
      label: 'Sign In Processing Time Percentiles',
      valuePrecision: 2,
      hide: false,
      hideHighlightedValue: true,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip:
        'Percentile processing time metrics for sign in operations within the auth server (excludes network latency).',
      entitlement: 'auth',
      requiredPlan: 'Pro',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'p50_processing_time_ms',
            label: 'P50 Processing Time (ms)',
          },
          {
            attribute: 'p95_processing_time_ms',
            label: 'P95 Processing Time (ms)',
          },
          {
            attribute: 'p99_processing_time_ms',
            label: 'P99 Processing Time (ms)',
          },
        ]

        const sql = AUTH_REPORT_SQL.SignInProcessingTimePercentiles(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
    {
      id: 'sign-up-processing-time-basic',
      label: 'Sign Up Processing Time',
      valuePrecision: 2,
      hide: false,
      hideHighlightedValue: true,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip:
        'Basic processing time metrics for sign up operations within the auth server (excludes network latency).',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'avg_processing_time_ms',
            label: 'Avg. Processing Time (ms)',
          },
          {
            attribute: 'min_processing_time_ms',
            label: 'Min. Processing Time (ms)',
          },
          {
            attribute: 'max_processing_time_ms',
            label: 'Max. Processing Time (ms)',
          },
        ]

        const sql = AUTH_REPORT_SQL.SignUpProcessingTimeBasic(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
    {
      id: 'sign-up-processing-time-percentiles',
      label: 'Sign Up Processing Time Percentiles',
      valuePrecision: 2,
      hide: false,
      hideHighlightedValue: true,
      showTooltip: true,
      showLegend: true,
      showMaxValue: false,
      hideChartType: false,
      defaultChartStyle: 'line',
      titleTooltip:
        'Percentile processing time metrics for sign up operations within the auth server (excludes network latency).',
      entitlement: 'auth',
      requiredPlan: 'Pro',
      dataProvider: async () => {
        const attributes = [
          {
            attribute: 'p50_processing_time_ms',
            label: 'P50 Processing Time (ms)',
          },
          {
            attribute: 'p95_processing_time_ms',
            label: 'P95 Processing Time (ms)',
          },
          {
            attribute: 'p99_processing_time_ms',
            label: 'P99 Processing Time (ms)',
          },
        ]

        const sql = AUTH_REPORT_SQL.SignUpProcessingTimePercentiles(interval, filters)
        const rawData = await fetchLogs(projectRef, sql, startDate, endDate)
        const transformedData = defaultAuthReportFormatter(rawData, attributes, groupByProvider)

        return {
          data: transformedData.data,
          attributes: transformedData.chartAttributes,
          query: sql,
        }
      },
    },
  ]
}

export const createAuthReportConfig = ({
  projectRef,
  startDate,
  endDate,
  interval,
  filters,
}: {
  projectRef: string
  startDate: string
  endDate: string
  interval: AnalyticsInterval
  filters: AuthReportFilters
}): ReportConfig<AuthReportFilters>[] => [
  ...createUsageReportConfig({ projectRef, startDate, endDate, interval, filters }),
  ...createErrorsReportConfig({ projectRef, startDate, endDate, interval, filters }),
  ...createLatencyReportConfig({ projectRef, startDate, endDate, interval, filters }),
]
