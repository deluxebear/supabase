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

describe('METRIC_SQL dialect — pg', () => {
  it('ExecutionStatusCodes/InvocationsByRegion: group by 1, 2 / order by 1 desc', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    for (const key of ['ExecutionStatusCodes', 'InvocationsByRegion']) {
      const sql = mod.METRIC_SQL[key]('1h', undefined)
      expect(sql).not.toMatch(/group by\s*\n?\s*timestamp,/i)
      expect(sql).not.toMatch(/order by\s*\n?\s*timestamp desc/i)
      expect(sql).toMatch(/group by 1, 2\b/i)
      expect(sql).toMatch(/order by 1 desc/i)
    }
  })

  // [self-platform] M6.2 T3 live-verification finding (beyond the Step 1
  // pins): bare `function_id` and `avg(m.execution_time_ms)` both 500 on
  // `function_edge_logs` (self-hosted's vector.yml never populates either —
  // same root cause T2 already traced). TotalInvocations/ExecutionTime drop
  // function_id (their own consumers discard function_name either way) and
  // ExecutionTime flatlines the uncomputable avg to 0 (networkTraffic
  // precedent).
  it('TotalInvocations: drops function_id, groups by 1 only', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    const sql = mod.METRIC_SQL.TotalInvocations('1h', undefined)
    expect(sql).not.toMatch(/function_id/i)
    expect(sql).not.toMatch(/group by\s*\n?\s*timestamp,/i)
    expect(sql).toMatch(/group by 1\b/i)
    expect(sql).toMatch(/order by 1 desc/i)
  })

  it('ExecutionTime: drops function_id, flatlines avg_execution_time to 0', async () => {
    const mod = await loadEdgeFunctionsConfig(...PG_SELF_PLATFORM)
    const sql = mod.METRIC_SQL.ExecutionTime('1h', undefined)
    expect(sql).not.toMatch(/function_id/i)
    expect(sql).not.toMatch(/avg\(/i)
    expect(sql).toMatch(/0 as avg_execution_time/i)
    expect(sql).toMatch(/group by 1\b/i)
    expect(sql).toMatch(/order by 1 desc/i)
  })
})
