import { afterEach, describe, expect, it, vi } from 'vitest'

// [self-platform] M6.2 T3 — see report-sql.pg-dialect.test.ts for the full
// rationale of the `vi.doUnmock('common')` step.
async function loadEdgeFunctionsConfig(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return await import('./edge-functions.config')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const CLOUD = ['true', ''] as const
const PG_SELF_PLATFORM = ['true', 'true'] as const

// Captured verbatim from the pre-M6.2 source, calling
// METRIC_SQL[key]('1h', undefined) for every key — before any dialect-gate edit.
const EDGE_FUNCTIONS_BQ_SNAPSHOT: Record<string, string> = {
  TotalInvocations:
    '\n--edgefn-report-invocations\nselect\n  timestamp_trunc(timestamp, hour) as timestamp,\n  function_id,\n  count(*) as count\nfrom\n  function_edge_logs\n  CROSS JOIN UNNEST(metadata) AS m\n  CROSS JOIN UNNEST(m.request) AS request\n  CROSS JOIN UNNEST(m.response) AS response\n  CROSS JOIN UNNEST(response.headers) AS h\n  \ngroup by\n  timestamp,\n  function_id\norder by\n  timestamp desc;\n',
  ExecutionStatusCodes:
    '\n--edgefn-report-execution-status-codes\nselect\n  timestamp_trunc(timestamp, hour) as timestamp,\n  response.status_code as status_code,\n  count(response.status_code) as count\nfrom\n  function_edge_logs\n  cross join unnest(metadata) as m\n  cross join unnest(m.response) as response\n  cross join unnest(response.headers) as h\n  \ngroup by\n  timestamp,\n  status_code\norder by\n  timestamp desc\n',
  InvocationsByRegion:
    '\n--edgefn-report-invocations-by-region\nselect\n  timestamp_trunc(timestamp, hour) as timestamp,\n  h.x_sb_edge_region as region,\n  count(*) as count\nfrom\n  function_edge_logs\n  cross join unnest(metadata) as m\n  cross join unnest(m.response) as r\n  cross join unnest(r.headers) as h\n  \n  WHERE h.x_sb_edge_region is not null\ngroup by\n  timestamp,\n  region\norder by\n  timestamp desc\n',
  ExecutionTime:
    '\n--edgefn-report-execution-time\nselect\n  timestamp_trunc(timestamp, hour) as timestamp,\n  function_id,\n  avg(m.execution_time_ms) as avg_execution_time\nfrom\n  function_edge_logs\n  cross join unnest(metadata) as m\n  cross join unnest(m.request) as request\n  cross join unnest(m.response) as response\n  cross join unnest(response.headers) as h\n  \ngroup by\n  timestamp,\n  function_id\norder by\n  timestamp desc\n',
}

describe('METRIC_SQL dialect — cloud byte-identity', () => {
  it('BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const mod = await loadEdgeFunctionsConfig(...CLOUD)
    for (const [key, expected] of Object.entries(EDGE_FUNCTIONS_BQ_SNAPSHOT)) {
      expect(mod.METRIC_SQL[key]('1h', undefined)).toBe(expected)
    }
  })
})

// [self-platform] Self-hosted reports no longer use METRIC_SQL: the `logs.all`
// translator reads the legacy deno-relay-logs source and rejects timestamp_trunc
// on function_edge_logs, so they run SELF_HOSTED_METRIC_SQL as native Postgres.
describe('METRIC_SQL on self-platform', () => {
  it('keeps the cloud BQ text (self-hosted gating lives at the call site)', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    for (const [key, expected] of Object.entries(EDGE_FUNCTIONS_BQ_SNAPSHOT)) {
      expect(mod.METRIC_SQL[key]('1h', undefined)).toBe(expected)
    }
  })
})

describe('SELF_HOSTED_METRIC_SQL', () => {
  const range = { startDate: '2026-10-02T13:00:00.000Z', endDate: '2026-10-02T14:00:00.000Z' }
  const noFilters = { functions: [], region: [], status_code: null, execution_time: null }

  it('routes every metric to the native Postgres path with explicit time bounds', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    for (const build of Object.values(mod.SELF_HOSTED_METRIC_SQL)) {
      const sql = build({ interval: '1m', ...range, filters: noFilters })
      expect(sql.startsWith('-- self-hosted unified logs')).toBe(true)
      expect(sql).toMatch(/from function_edge_logs/)
      expect(sql).toContain(
        "timestamp >= '2026-10-02T13:00:00.000Z' AND timestamp <= '2026-10-02T14:00:00.000Z'"
      )
      expect(sql).toMatch(/date_trunc\('minute', timestamp\)/)
      expect(sql).not.toMatch(/timestamp_trunc|unnest/i)
    }
  })

  it('applies every filter against the ingested metadata', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    const sql = mod.SELF_HOSTED_METRIC_SQL.TotalInvocations({
      interval: '1h',
      ...range,
      filters: {
        functions: ['project-d:hello', "o'brien"],
        region: ['local'],
        status_code: { operator: '>=', value: 400 },
        execution_time: { operator: '>', value: 10 },
      },
    })
    expect(sql).toContain("body->'metadata'->>'function_id' IN ('project-d:hello', 'o''brien')")
    expect(sql).toContain("(body->'metadata'->'response'->>'status_code')::int >= 400")
    expect(sql).toContain(
      "body->'metadata'->'response'->'headers'->>'x_sb_edge_region' IN ('local')"
    )
    expect(sql).toContain("(body->'metadata'->>'execution_time_ms')::float > 10")
    expect(sql).toMatch(/date_trunc\('hour', timestamp\)/)
  })

  it('falls back to the last hour when the date range is missing', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    const sql = mod.SELF_HOSTED_METRIC_SQL.ExecutionTime({
      interval: '1m',
      startDate: '',
      endDate: 'not a date',
      filters: noFilters,
    })
    const [, start, end] = sql.match(/timestamp >= '([^']+)' AND timestamp <= '([^']+)'/) ?? []
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(3_600_000)
  })
})
