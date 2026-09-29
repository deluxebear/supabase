import { afterEach, describe, expect, it, vi } from 'vitest'

// [self-platform] M6.2 E2E fix — genDefaultQuery's edge_logs/postgres_logs
// platform branches select the cloud-only `identifier` column, which is
// absent from self-hosted Logflare's PG-backed CTEs and 500s the BQ→PG
// translator. This pins the dialect gate: cloud keeps the `identifier`
// column byte-identically, self-platform (both flags true) drops it.
//
// `vi.doUnmock('common')` is required before every reload: tests/vitestSetup.ts
// globally mocks the `common` package by spreading `await importOriginal()`
// inside its factory, and that resolution is memoized across
// `vi.resetModules()` within one test file (a vite-node quirk — resetModules
// clears vitest's own registry, not the mock factory's cached
// `importOriginal` result). Without unmocking first, re-stubbing
// NEXT_PUBLIC_IS_PLATFORM to a different value later in the file would
// silently keep resolving IS_PLATFORM to whatever the first test saw.
async function loadGenDefaultQuery(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  const constants = await import('./Logs.constants')
  const utils = await import('./Logs.utils')
  return {
    LogsTableName: constants.LogsTableName,
    genDefaultQuery: utils.genDefaultQuery,
    genCountQuery: utils.genCountQuery,
    genChartQuery: utils.genChartQuery,
    genSingleLogQuery: utils.genSingleLogQuery,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const CLOUD = ['true', ''] as const
const PG_SELF_PLATFORM = ['true', 'true'] as const

describe('Logs.utils genDefaultQuery dialect', () => {
  it('self-platform: function invocations use the normalized message and exact path', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const sql = genDefaultQuery(LogsTableName.FN_EDGE, {
      function_invocation_path: '/functions/v1/quick-endpoint',
    })

    expect(sql).toContain("split_part(event_message, ' | ', 2) as status_code")
    expect(sql).toContain("split_part(event_message, ' | ', 3) = '/functions/v1/quick-endpoint'")
    expect(sql).not.toContain('unnest')
  })

  it('self-platform: function path filter escapes SQL literals', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const sql = genDefaultQuery(LogsTableName.FN_EDGE, {
      function_invocation_path: "/functions/v1/it's-safe",
    })

    expect(sql).toContain("= '/functions/v1/it''s-safe'")
  })

  it('self-platform: count, chart, and single-log queries avoid unavailable metadata', async () => {
    const { LogsTableName, genCountQuery, genChartQuery, genSingleLogQuery } =
      await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const filters = {
      function_invocation_path: '/functions/v1/quick-endpoint',
      __timestamp_start: '1790697600',
      __timestamp_end: '1790702400',
    }
    const countSql = genCountQuery(LogsTableName.FN_EDGE, filters)
    const chartSql = genChartQuery(
      LogsTableName.FN_EDGE,
      {
        iso_timestamp_start: '2026-09-29T00:00:00Z',
        iso_timestamp_end: '2026-09-29T01:00:00Z',
      },
      filters
    )
    const singleSql = genSingleLogQuery(LogsTableName.FN_EDGE, 'log-1')

    expect(countSql).not.toContain('unnest')
    expect(countSql).toContain('extract(epoch from timestamp) >= 1790697600')
    expect(countSql).toContain('extract(epoch from timestamp) < 1790702400')
    expect(chartSql).toContain("date_trunc('minute', t.timestamp)")
    expect(chartSql).toContain("split_part(event_message, ' | ', 2) like '5__'")
    expect(chartSql).not.toContain('unnest')
    expect(chartSql).not.toContain('t.timestamp >')
    expect(singleSql).not.toContain('metadata')
  })

  it('cloud: edge_logs keeps the identifier column byte-identically', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...CLOUD)
    const sql = genDefaultQuery(LogsTableName.EDGE, {})
    expect(sql).toContain('select id, identifier, timestamp, event_message')
  })

  it('cloud: postgres_logs keeps the identifier column byte-identically', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...CLOUD)
    const sql = genDefaultQuery(LogsTableName.POSTGRES, {})
    expect(sql).toContain('select identifier, postgres_logs.timestamp, id, event_message')
  })

  it('self-platform: edge_logs drops the identifier column (absent from self-hosted Logflare CTEs)', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const sql = genDefaultQuery(LogsTableName.EDGE, {})
    expect(sql).not.toContain('identifier')
  })

  it('self-platform: postgres_logs drops the identifier column (absent from self-hosted Logflare CTEs)', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const sql = genDefaultQuery(LogsTableName.POSTGRES, {})
    expect(sql).not.toContain('identifier')
  })

  it('cloud: function invocations keep the platform columns', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...CLOUD)
    const sql = genDefaultQuery(LogsTableName.FN_EDGE, {
      'metadata.function_id': 'project-d:quick-endpoint',
    })

    expect(sql).toContain('m.execution_time_ms, m.deployment_id, m.version')
    expect(sql).toContain("m.function_id = 'project-d:quick-endpoint'")
  })
})
