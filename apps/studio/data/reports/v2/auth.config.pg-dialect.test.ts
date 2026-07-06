import { afterEach, describe, expect, it, vi } from 'vitest'

// [self-platform] M6.2 T3 — see report-sql.pg-dialect.test.ts for the full
// rationale of the `vi.doUnmock('common')` step (works around a
// vite-node/Vitest quirk where tests/vitestSetup.ts's `common` mock
// memoizes its `importOriginal()` resolution across `vi.resetModules()`
// within one test file).
async function loadAuthConfig(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return await import('./auth.config')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const CLOUD = ['true', ''] as const
const PG_SELF_PLATFORM = ['true', 'true'] as const

// Captured verbatim from the pre-M6.2 source, calling
// AUTH_REPORT_SQL[key]('1h', undefined) for every key — before any
// dialect-gate edit.
const AUTH_BQ_NO_PROVIDER: Record<string, string> = {
  ActiveUsers:
    "\n        --active-users\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(distinct json_value(f.event_message, \"$.auth_event.actor_id\")) as count\n        from auth_logs f\n        where json_value(f.event_message, \"$.auth_event.action\") in (\n          'login', 'user_signedup', 'token_refreshed', 'user_modified',\n          'user_recovery_requested', 'user_reauthenticate_requested'\n        )\n        \n        group by timestamp\n        order by timestamp desc\n      ",
  SignInAttempts:
    '\n        --sign-in-attempts\n        SELECT\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          CASE\n            WHEN JSON_VALUE(event_message, "$.provider") IS NOT NULL\n                AND JSON_VALUE(event_message, "$.provider") != \'\'\n            THEN CONCAT(\n              JSON_VALUE(event_message, "$.login_method"),\n              \' (\',\n              JSON_VALUE(event_message, "$.provider"),\n              \')\'\n            )\n            ELSE JSON_VALUE(event_message, "$.login_method")\n          END as login_type_provider,\n          COUNT(*) as count\n        FROM\n          auth_logs\n        WHERE\n          JSON_VALUE(event_message, "$.action") = \'login\'\n          AND JSON_VALUE(event_message, "$.metering") = "true"\n          \n        GROUP BY\n          timestamp, login_type_provider\n        ORDER BY\n          timestamp desc, login_type_provider\n      ',
  PasswordResetRequests:
    '\n        --password-reset-requests\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(*) as count\n        from auth_logs f\n        where json_value(f.event_message, "$.auth_event.action") = \'user_recovery_requested\'\n        \n        group by timestamp\n        order by timestamp desc\n      ',
  TotalSignUps:
    '\n        --total-signups\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(*) as count\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'user_signedup\'\n        \n        group by timestamp\n        order by timestamp desc\n      ',
  SignInProcessingTimeBasic:
    '\n        --signin-processing-time-basic\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(*) as count,\n          round(avg(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as avg_processing_time_ms,\n          round(min(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as min_processing_time_ms,\n          round(max(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as max_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'login\'\n        \n        group by timestamp\n        order by timestamp desc\n      ',
  SignInProcessingTimePercentiles:
    '\n        --signin-processing-time-percentiles\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(*) as count,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(50)] / 1000000, 2) as p50_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(95)] / 1000000, 2) as p95_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(99)] / 1000000, 2) as p99_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'login\'\n        \n        group by timestamp\n        order by timestamp desc\n      ',
  SignUpProcessingTimeBasic:
    '\n        --signup-processing-time-basic\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(*) as count,\n          round(avg(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as avg_processing_time_ms,\n          round(min(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as min_processing_time_ms,\n          round(max(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as max_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'user_signedup\'\n        \n        group by timestamp\n        order by timestamp desc\n      ',
  SignUpProcessingTimePercentiles:
    '\n        --signup-processing-time-percentiles\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          \n          count(*) as count,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(50)] / 1000000, 2) as p50_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(95)] / 1000000, 2) as p95_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(99)] / 1000000, 2) as p99_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'user_signedup\'\n        \n        group by timestamp\n        order by timestamp desc\n      ',
  ErrorsByStatus:
    "\n        --auth-errors-by-status\n  select\n    timestamp_trunc(timestamp, hour) as timestamp,\n    count(*) as count,\n    response.status_code\n  from edge_logs\n    cross join unnest(metadata) as m\n    cross join unnest(m.request) as request\n    cross join unnest(m.response) as response\n    cross join unnest(response.headers) as h\n  where path like '%auth/v1%'\n    and response.status_code >= 400 and response.status_code <= 599\n    \n  group by timestamp, status_code\n  order by timestamp desc\n      ",
  ErrorsByAuthCode:
    "\n        --auth-errors-by-code\n  select\n    timestamp_trunc(timestamp, hour) as timestamp,\n    count(*) as count,\n    h.x_sb_error_code as error_code\n  from edge_logs\n    cross join unnest(metadata) as m\n    cross join unnest(m.request) as request\n    cross join unnest(m.response) as response\n    cross join unnest(response.headers) as h\n  where path like '%auth/v1%'\n    and response.status_code >= 400 and response.status_code <= 599\n    \n  group by timestamp, error_code\n  order by timestamp desc\n      ",
}

// Captured verbatim, calling AUTH_REPORT_SQL[key]('1h', { provider: ['google'] }).
const AUTH_BQ_WITH_PROVIDER: Record<string, string> = {
  ActiveUsers:
    "\n        --active-users\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(f.event_message, \"$.provider\"), 'unknown') as provider,\n          count(distinct json_value(f.event_message, \"$.auth_event.actor_id\")) as count\n        from auth_logs f\n        where json_value(f.event_message, \"$.auth_event.action\") in (\n          'login', 'user_signedup', 'token_refreshed', 'user_modified',\n          'user_recovery_requested', 'user_reauthenticate_requested'\n        )\n        AND JSON_VALUE(event_message, \"$.provider\") IN ('google')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ",
  SignInAttempts:
    '\n        --sign-in-attempts\n        SELECT\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(event_message, "$.provider"), \'unknown\') as provider,\n          CASE\n            WHEN JSON_VALUE(event_message, "$.provider") IS NOT NULL\n                AND JSON_VALUE(event_message, "$.provider") != \'\'\n            THEN CONCAT(\n              JSON_VALUE(event_message, "$.login_method"),\n              \' (\',\n              JSON_VALUE(event_message, "$.provider"),\n              \')\'\n            )\n            ELSE JSON_VALUE(event_message, "$.login_method")\n          END as login_type_provider,\n          COUNT(*) as count\n        FROM\n          auth_logs\n        WHERE\n          JSON_VALUE(event_message, "$.action") = \'login\'\n          AND JSON_VALUE(event_message, "$.metering") = "true"\n          AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        GROUP BY\n          timestamp, login_type_provider, provider\n        ORDER BY\n          timestamp desc, login_type_provider, provider\n      ',
  PasswordResetRequests:
    '\n        --password-reset-requests\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(f.event_message, "$.provider"), \'unknown\') as provider,\n          count(*) as count\n        from auth_logs f\n        where json_value(f.event_message, "$.auth_event.action") = \'user_recovery_requested\'\n        AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ',
  TotalSignUps:
    '\n        --total-signups\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(event_message, "$.provider"), \'unknown\') as provider,\n          count(*) as count\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'user_signedup\'\n        AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ',
  SignInProcessingTimeBasic:
    '\n        --signin-processing-time-basic\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(event_message, "$.provider"), \'unknown\') as provider,\n          count(*) as count,\n          round(avg(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as avg_processing_time_ms,\n          round(min(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as min_processing_time_ms,\n          round(max(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as max_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'login\'\n        AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ',
  SignInProcessingTimePercentiles:
    '\n        --signin-processing-time-percentiles\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(event_message, "$.provider"), \'unknown\') as provider,\n          count(*) as count,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(50)] / 1000000, 2) as p50_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(95)] / 1000000, 2) as p95_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(99)] / 1000000, 2) as p99_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'login\'\n        AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ',
  SignUpProcessingTimeBasic:
    '\n        --signup-processing-time-basic\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(event_message, "$.provider"), \'unknown\') as provider,\n          count(*) as count,\n          round(avg(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as avg_processing_time_ms,\n          round(min(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as min_processing_time_ms,\n          round(max(cast(json_value(event_message, "$.duration") as int64)) / 1000000, 2) as max_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'user_signedup\'\n        AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ',
  SignUpProcessingTimePercentiles:
    '\n        --signup-processing-time-percentiles\n        select\n          timestamp_trunc(timestamp, hour) as timestamp,\n          COALESCE(JSON_VALUE(event_message, "$.provider"), \'unknown\') as provider,\n          count(*) as count,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(50)] / 1000000, 2) as p50_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(95)] / 1000000, 2) as p95_processing_time_ms,\n          round(approx_quantiles(cast(json_value(event_message, "$.duration") as int64), 100)[offset(99)] / 1000000, 2) as p99_processing_time_ms\n        from auth_logs\n        where json_value(event_message, "$.auth_event.action") = \'user_signedup\'\n        AND JSON_VALUE(event_message, "$.provider") IN (\'google\')\n        group by timestamp, provider\n        order by timestamp desc, provider\n      ',
  ErrorsByStatus:
    "\n        --auth-errors-by-status\n  select\n    timestamp_trunc(timestamp, hour) as timestamp,\n    count(*) as count,\n    response.status_code\n  from edge_logs\n    cross join unnest(metadata) as m\n    cross join unnest(m.request) as request\n    cross join unnest(m.response) as response\n    cross join unnest(response.headers) as h\n  where path like '%auth/v1%'\n    and response.status_code >= 400 and response.status_code <= 599\n    \n  group by timestamp, status_code\n  order by timestamp desc\n      ",
  ErrorsByAuthCode:
    "\n        --auth-errors-by-code\n  select\n    timestamp_trunc(timestamp, hour) as timestamp,\n    count(*) as count,\n    h.x_sb_error_code as error_code\n  from edge_logs\n    cross join unnest(metadata) as m\n    cross join unnest(m.request) as request\n    cross join unnest(m.response) as response\n    cross join unnest(response.headers) as h\n  where path like '%auth/v1%'\n    and response.status_code >= 400 and response.status_code <= 599\n    \n  group by timestamp, error_code\n  order by timestamp desc\n      ",
}

describe('AUTH_REPORT_SQL dialect — cloud byte-identity', () => {
  it('no-provider: BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const mod = await loadAuthConfig(...CLOUD)
    for (const [key, expected] of Object.entries(AUTH_BQ_NO_PROVIDER)) {
      expect(mod.AUTH_REPORT_SQL[key]('1h', undefined)).toBe(expected)
    }
  })

  it('with-provider: BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const mod = await loadAuthConfig(...CLOUD)
    for (const [key, expected] of Object.entries(AUTH_BQ_WITH_PROVIDER)) {
      expect(mod.AUTH_REPORT_SQL[key]('1h', { provider: ['google'] })).toBe(expected)
    }
  })
})

// The 8 templates that get ordinal PG rewrites (json_value pinned OK — T2 Step 1).
const ORDINAL_KEYS = [
  'ActiveUsers',
  'PasswordResetRequests',
  'TotalSignUps',
  'SignInProcessingTimeBasic',
  'SignUpProcessingTimeBasic',
]

// approx_quantiles pinned BROKEN (500) — these two keep the BQ text in BOTH
// branches (existing chart error state surfaces; README known-limitation).
const PERCENTILE_KEYS = ['SignInProcessingTimePercentiles', 'SignUpProcessingTimePercentiles']

describe('AUTH_REPORT_SQL dialect — pg', () => {
  it('simple usage templates: group by 1[, 2] / order by 1 desc[, 2]', async () => {
    const mod = await loadAuthConfig(...PG_SELF_PLATFORM)
    for (const key of ORDINAL_KEYS) {
      const noProvider = mod.AUTH_REPORT_SQL[key]('1h', undefined)
      expect(noProvider).not.toMatch(/group by\s+timestamp\b/i)
      expect(noProvider).not.toMatch(/order by\s+timestamp\b/i)
      expect(noProvider).toMatch(/group by 1\s*$/im)
      expect(noProvider).toMatch(/order by 1 desc\s*$/im)

      const withProvider = mod.AUTH_REPORT_SQL[key]('1h', { provider: ['google'] })
      expect(withProvider).toMatch(/group by 1, 2\s*$/im)
      expect(withProvider).toMatch(/order by 1 desc, 2\s*$/im)
    }
  })

  it('SignInAttempts: login_type_provider ordinal shifts with groupByProvider', async () => {
    const mod = await loadAuthConfig(...PG_SELF_PLATFORM)
    const noProvider = mod.AUTH_REPORT_SQL.SignInAttempts('1h', undefined)
    expect(noProvider).not.toMatch(/group by\s+timestamp\b/i)
    expect(noProvider).toMatch(/group by\s+1, 2\s*$/im)
    expect(noProvider).toMatch(/order by\s+1 desc, 2\s*$/im)

    const withProvider = mod.AUTH_REPORT_SQL.SignInAttempts('1h', { provider: ['google'] })
    expect(withProvider).toMatch(/group by\s+1, 3, 2\s*$/im)
    expect(withProvider).toMatch(/order by\s+1 desc, 3, 2\s*$/im)
  })

  it('ErrorsByStatus / ErrorsByAuthCode: group by 1, 3 order by 1 desc, request.path (not bare path)', async () => {
    const mod = await loadAuthConfig(...PG_SELF_PLATFORM)
    for (const key of ['ErrorsByStatus', 'ErrorsByAuthCode']) {
      const sql = mod.AUTH_REPORT_SQL[key]('1h', undefined)
      expect(sql).not.toMatch(/group by\s+timestamp\b/i)
      expect(sql).toMatch(/group by 1, 3\s*$/im)
      expect(sql).toMatch(/order by 1 desc\s*$/im)
      // [self-platform] M6.2 T3 live-verification finding: bare `path` 500s
      // on edge_logs here (never populated at the top level self-hosted) —
      // the PG variant must use the already-unnested `request.path`.
      expect(sql).toMatch(/where request\.path like/i)
      expect(sql).not.toMatch(/where path like/i)
    }
  })

  it('Percentiles templates keep their own BQ text unchanged (approx_quantiles pinned broken)', async () => {
    const mod = await loadAuthConfig(...PG_SELF_PLATFORM)
    for (const key of PERCENTILE_KEYS) {
      // no-provider: providerSelectFragment/authFiltersToAndPredicates are
      // no-ops (EMPTY) when there's no provider filter, so the whole
      // template is untouched — byte-identical to the pre-M6.2 BQ text.
      expect(mod.AUTH_REPORT_SQL[key]('1h', undefined)).toBe(AUTH_BQ_NO_PROVIDER[key])

      // with-provider: this template's OWN body (approx_quantiles, the
      // "$.duration"/"$.auth_event.action" json_value paths) is untouched —
      // still double-quoted, still broken (approx_quantiles 500s regardless
      // of the quote-style fix; this is a genuinely dead PG code path, not
      // worth partially patching). But the shared
      // providerSelectFragment/authFiltersToAndPredicates helpers are
      // globally dialect-gated (every other template needs them fixed —
      // see PROVIDER_SELECT_FRAGMENT's comment) and correctly single-quote
      // their `$.provider` path even here, since that gate isn't scoped
      // per-template.
      const withProvider = mod.AUTH_REPORT_SQL[key]('1h', { provider: ['google'] })
      expect(withProvider).toMatch(/approx_quantiles/)
      expect(withProvider).toMatch(/"\$\.duration"/)
      expect(withProvider).toMatch(/"\$\.auth_event\.action"/)
      expect(withProvider).toMatch(
        /JSON_VALUE\(event_message, '\$\.provider'\), 'unknown'\) as provider/
      )
      expect(withProvider).toMatch(/JSON_VALUE\(event_message, '\$\.provider'\) IN \('google'\)/)
    }
  })
})
