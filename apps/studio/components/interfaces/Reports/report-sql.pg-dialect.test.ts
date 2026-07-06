import { afterEach, describe, expect, it, vi } from 'vitest'

// [self-platform] M6.2 T3 — dialect gate coverage for every report-SQL
// surface touched by this task: SharedAPIReport + PRESET_CONFIG (this file's
// primary scope) plus Logs.utils' genChartQuery (folded in here rather than
// a separate sibling file — see brief Step 2's parenthetical, which
// describes it immediately after this file's scope with no dedicated
// sibling file named for it).
//
// `vi.doUnmock('common')` is required before every reload: tests/vitestSetup.ts
// globally mocks the `common` package by spreading `await importOriginal()`
// inside its factory, and that resolution is memoized across
// `vi.resetModules()` within one test file (a vite-node quirk — resetModules
// clears vitest's own registry, not the mock factory's cached
// `importOriginal` result). Without unmocking first, re-stubbing
// NEXT_PUBLIC_IS_PLATFORM to a different value later in the file would
// silently keep resolving IS_PLATFORM to whatever the first test saw.
async function loadShared(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return await import('./SharedAPIReport/SharedAPIReport.constants')
}

async function loadPreset(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  const constants = await import('./Reports.constants')
  const types = await import('./Reports.types')
  return { PRESET_CONFIG: constants.PRESET_CONFIG, Presets: types.Presets }
}

async function loadGenChartQuery(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  const constants = await import('@/components/interfaces/Settings/Logs/Logs.constants')
  const utils = await import('@/components/interfaces/Settings/Logs/Logs.utils')
  return { LogsTableName: constants.LogsTableName, genChartQuery: utils.genChartQuery }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const CLOUD = ['true', ''] as const
const PG_SELF_PLATFORM = ['true', 'true'] as const

// Captured verbatim from the pre-M6.2 source (SharedAPIReport.constants.ts),
// calling each template's safeSql([], 'edge_logs') — before any dialect-gate
// edit. This is the byte-identity pin for cloud.
const SHARED_BQ_SNAPSHOT: Record<string, string> = {
  totalRequests:
    '\n        --reports-api-total-requests\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          count(t.id) as count\n        FROM edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC',
  topRoutes:
    '\n        -- reports-api-top-routes\n        select\n          request.path as path,\n          request.method as method,\n          request.search as search,\n          response.status_code as status_code,\n          count(t.id) as count\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          \n        group by\n          request.path, request.method, request.search, response.status_code\n        order by\n          count desc\n        limit 10\n        ',
  errorCounts:
    '\n        -- reports-api-error-counts\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          count(t.id) as count\n        FROM edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n        WHERE\n          response.status_code >= 400\n        \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC\n        ',
  topErrorRoutes:
    '\n        -- reports-api-top-error-routes\n        select\n          request.path as path,\n          request.method as method,\n          request.search as search,\n          response.status_code as status_code,\n          count(t.id) as count\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n        where\n          response.status_code >= 400\n        \n        group by\n          request.path, request.method, request.search, response.status_code\n        order by\n          count desc\n        limit 10\n        ',
  responseSpeed:
    '\n        -- reports-api-response-speed\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          avg(response.origin_time) as avg\n        FROM\n          edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC\n      ',
  topSlowRoutes:
    '\n        -- reports-api-top-slow-routes\n        select\n          request.path as path,\n          request.method as method,\n          request.search as search,\n          response.status_code as status_code,\n          count(t.id) as count,\n          avg(response.origin_time) as avg\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n        \n        group by\n          request.path, request.method, request.search, response.status_code\n        order by\n          avg desc\n        limit 10\n        ',
  networkTraffic:
    '\n        -- reports-api-network-traffic\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          coalesce(\n            safe_divide(\n              sum(\n                cast(coalesce(headers.content_length, "0") as int64)\n              ),\n              1000000\n            ),\n            0\n          ) as ingress_mb,\n          coalesce(\n            safe_divide(\n              sum(\n                cast(coalesce(resp_headers.content_length, "0") as int64)\n              ),\n              1000000\n            ),\n            0\n          ) as egress_mb,\n        FROM\n          edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          cross join unnest(response.headers) as resp_headers\n          \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC\n        ',
}

// Captured verbatim from PRESET_CONFIG[Presets.API].queries, calling each
// template's safeSql([]) — before any dialect-gate edit.
const PRESET_API_BQ_SNAPSHOT: Record<string, string> = {
  totalRequests:
    '\n        -- reports-api-total-requests\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          count(t.id) as count\n        FROM edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC',
  topRoutes:
    '\n        -- reports-api-top-routes\n        select\n          request.path as path,\n          request.method as method,\n          request.search as search,\n          response.status_code as status_code,\n          count(t.id) as count\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          \n        group by\n          request.path, request.method, request.search, response.status_code\n        order by\n          count desc\n        limit 10\n        ',
  errorCounts:
    '\n        -- reports-api-error-counts\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          count(t.id) as count\n        FROM edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n        WHERE\n          response.status_code >= 400\n        \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC\n        ',
  topErrorRoutes:
    '\n        -- reports-api-top-error-routes\n        select\n          request.path as path,\n          request.method as method,\n          request.search as search,\n          response.status_code as status_code,\n          count(t.id) as count\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n        where\n          response.status_code >= 400\n        \n        group by\n          request.path, request.method, request.search, response.status_code\n        order by\n          count desc\n        limit 10\n        ',
  responseSpeed:
    '\n        -- reports-api-response-speed\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          avg(response.origin_time) as avg\n        FROM\n          edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC\n      ',
  topSlowRoutes:
    '\n        -- reports-api-top-slow-routes\n        select\n          request.path as path,\n          request.method as method,\n          request.search as search,\n          response.status_code as status_code,\n          count(t.id) as count,\n          avg(response.origin_time) as avg\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n        \n        group by\n          request.path, request.method, request.search, response.status_code\n        order by\n          avg desc\n        limit 10\n        ',
  networkTraffic:
    '\n        -- reports-api-network-traffic\n        select\n          cast(timestamp_trunc(t.timestamp, hour) as datetime) as timestamp,\n          coalesce(\n            safe_divide(\n              sum(\n                cast(coalesce(headers.content_length, "0") as int64)\n              ),\n              1000000\n            ),\n            0\n          ) as ingress_mb,\n          coalesce(\n            safe_divide(\n              sum(\n                cast(coalesce(resp_headers.content_length, "0") as int64)\n              ),\n              1000000\n            ),\n            0\n          ) as egress_mb,\n        FROM\n          edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          cross join unnest(response.headers) as resp_headers\n          \n        GROUP BY\n          timestamp\n        ORDER BY\n          timestamp ASC\n        ',
  requestsByCountry:
    '\n        -- reports-api-requests-by-country\n        select\n          cf.country as country,\n          count(t.id) as count\n        from edge_logs t\n          cross join unnest(metadata) as m\n          cross join unnest(m.response) as response\n          cross join unnest(m.request) as request\n          cross join unnest(request.headers) as headers\n          cross join unnest(request.cf) as cf\n        where\n          cf.country is not null\n        \n        group by\n          cf.country\n        ',
}

// Captured verbatim from PRESET_CONFIG[Presets.STORAGE].queries.
const PRESET_STORAGE_BQ_SNAPSHOT: Record<string, string> = {
  cacheHitRate:
    "\n        -- reports-storage-cache-hit-rate\nSELECT\n  timestamp_trunc(timestamp, hour) as timestamp,\n  countif( h.cf_cache_status in ('HIT', 'STALE', 'REVALIDATED', 'UPDATING') ) as hit_count,\n  countif( h.cf_cache_status in ('MISS', 'NONE/UNKNOWN', 'EXPIRED', 'BYPASS', 'DYNAMIC') ) as miss_count\nfrom edge_logs f\n  cross join unnest(f.metadata) as m\n  cross join unnest(m.request) as r\n  cross join unnest(m.response) as res\n  cross join unnest(res.headers) as h\nwhere starts_with(r.path, '/storage/v1/object') and r.method = 'GET'\n  \ngroup by timestamp\norder by timestamp desc\n",
  topCacheMisses:
    "\n        -- reports-storage-top-cache-misses\nSELECT\n  r.path as path,\n  r.search as search,\n  count(id) as count\nfrom edge_logs f\n  cross join unnest(f.metadata) as m\n  cross join unnest(m.request) as r\n  cross join unnest(m.response) as res\n  cross join unnest(res.headers) as h\nwhere starts_with(r.path, '/storage/v1/object')\n  and r.method = 'GET'\n  and h.cf_cache_status in ('MISS', 'NONE/UNKNOWN', 'EXPIRED', 'BYPASS', 'DYNAMIC')\n  \ngroup by path, search\norder by count desc\nlimit 12\n    ",
}

// Captured verbatim from Logs.utils.genChartQuery(LogsTableName.EDGE, {...}, {}).
const GEN_CHART_QUERY_BQ_SNAPSHOT =
  "\nSELECT\n-- log-event-chart\n  timestamp_trunc(t.timestamp, hour) as timestamp,\n  count(CASE WHEN NOT (response.status_code >= 500 OR response.status_code >= 400 AND response.status_code < 500) THEN 1 END) as ok_count,\n  count(CASE WHEN response.status_code >= 500 THEN 1 END) as error_count,\n  count(CASE WHEN response.status_code >= 400 AND response.status_code < 500 THEN 1 END) as warning_count,\nFROM\n  edge_logs t\n  cross join unnest(metadata) as m\n  cross join unnest(m.request) as request\n  cross join unnest(m.response) as response\n  where t.timestamp > '2026-06-26T00:00:00.000Z'\nGROUP BY\ntimestamp\nORDER BY\n  timestamp ASC\n  "

describe('SharedAPIReport dialect', () => {
  it('cloud: BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const mod = await loadShared(...CLOUD)
    for (const [key, expected] of Object.entries(SHARED_BQ_SNAPSHOT)) {
      const actual = (mod.SHARED_API_REPORT_SQL as any)[key].safeSql([], 'edge_logs')
      expect(actual).toBe(expected)
    }
  })

  it('pg: no datetime casts, no shadowing-alias group/order-bys', async () => {
    const mod = await loadShared(...PG_SELF_PLATFORM)
    for (const key of Object.keys(SHARED_BQ_SNAPSHOT)) {
      const sql: string = (mod.SHARED_API_REPORT_SQL as any)[key].safeSql([], 'edge_logs')
      expect(sql).not.toMatch(/as datetime/i)
      // shadowing-alias trap tripwire: `timestamp_trunc(t.timestamp, hour) as
      // timestamp` shadows the raw `timestamp` column — `group/order by
      // timestamp` would silently group by the RAW column on the PG
      // translator, not the truncated bucket.
      expect(sql).not.toMatch(/group by\s+timestamp\b/i)
      expect(sql).not.toMatch(/order by\s+timestamp\b/i)
    }
  })

  it('pg: totalRequests/errorCounts/responseSpeed use GROUP BY 1 / ORDER BY 1 ASC', async () => {
    const mod = await loadShared(...PG_SELF_PLATFORM)
    for (const key of ['totalRequests', 'errorCounts', 'responseSpeed']) {
      const sql: string = (mod.SHARED_API_REPORT_SQL as any)[key].safeSql([], 'edge_logs')
      expect(sql).toMatch(/group by 1\b/i)
      expect(sql).toMatch(/order by 1 asc/i)
    }
  })

  it('pg: topRoutes/topErrorRoutes group by 1,2,3,4 order by 5 desc', async () => {
    const mod = await loadShared(...PG_SELF_PLATFORM)
    for (const key of ['topRoutes', 'topErrorRoutes']) {
      const sql: string = (mod.SHARED_API_REPORT_SQL as any)[key].safeSql([], 'edge_logs')
      expect(sql).toMatch(/group by 1, 2, 3, 4/i)
      expect(sql).toMatch(/order by 5 desc/i)
    }
  })

  it('pg: responseSpeed is an honest 0-flatline (avg(response.origin_time) pinned broken)', async () => {
    const mod = await loadShared(...PG_SELF_PLATFORM)
    const sql: string = (mod.SHARED_API_REPORT_SQL as any).responseSpeed.safeSql([], 'edge_logs')
    expect(sql).not.toMatch(/avg\(/i)
    expect(sql).toMatch(/0 as avg/i)
    expect(sql).toMatch(/group by 1\b/i)
    expect(sql).toMatch(/order by 1 asc/i)
  })

  it('pg: topSlowRoutes keeps the BQ text unchanged (avg(response.origin_time) pinned broken; flatlining would fake the ranking)', async () => {
    const mod = await loadShared(...CLOUD)
    const bqSql: string = (mod.SHARED_API_REPORT_SQL as any).topSlowRoutes.safeSql([], 'edge_logs')
    const pgMod = await loadShared(...PG_SELF_PLATFORM)
    const pgSql: string = (pgMod.SHARED_API_REPORT_SQL as any).topSlowRoutes.safeSql(
      [],
      'edge_logs'
    )
    expect(pgSql).toBe(bqSql)
    expect(pgSql).toMatch(/avg\(response\.origin_time\)/i)
  })

  it('pg: networkTraffic is an honest 0-flatline (safe_divide/int64 pinned broken)', async () => {
    const mod = await loadShared(...PG_SELF_PLATFORM)
    const sql: string = (mod.SHARED_API_REPORT_SQL as any).networkTraffic.safeSql([], 'edge_logs')
    expect(sql).not.toMatch(/safe_divide/i)
    expect(sql).toMatch(/0 as ingress_mb/i)
    expect(sql).toMatch(/0 as egress_mb/i)
    expect(sql).toMatch(/group by 1\b/i)
    expect(sql).toMatch(/order by 1 asc/i)
  })
})

describe('PRESET_CONFIG (api) dialect', () => {
  it('cloud: BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const { PRESET_CONFIG, Presets } = await loadPreset(...CLOUD)
    for (const [key, expected] of Object.entries(PRESET_API_BQ_SNAPSHOT)) {
      const actual = (PRESET_CONFIG[Presets.API].queries as any)[key].safeSql([])
      expect(actual).toBe(expected)
    }
  })

  it('pg: no datetime casts, no shadowing-alias group/order-bys', async () => {
    const { PRESET_CONFIG, Presets } = await loadPreset(...PG_SELF_PLATFORM)
    for (const key of Object.keys(PRESET_API_BQ_SNAPSHOT)) {
      const sql: string = (PRESET_CONFIG[Presets.API].queries as any)[key].safeSql([])
      expect(sql).not.toMatch(/as datetime/i)
      expect(sql).not.toMatch(/group by\s+timestamp\b/i)
      expect(sql).not.toMatch(/order by\s+timestamp\b/i)
    }
  })

  it('pg: requestsByCountry groups by 1 only — no new order-by added', async () => {
    const { PRESET_CONFIG, Presets } = await loadPreset(...PG_SELF_PLATFORM)
    const sql: string = (PRESET_CONFIG[Presets.API].queries as any).requestsByCountry.safeSql([])
    expect(sql).toMatch(/group by 1\b/i)
    expect(sql).not.toMatch(/order by/i)
  })
})

describe('PRESET_CONFIG (storage) dialect', () => {
  it('cloud: BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const { PRESET_CONFIG, Presets } = await loadPreset(...CLOUD)
    for (const [key, expected] of Object.entries(PRESET_STORAGE_BQ_SNAPSHOT)) {
      const actual = (PRESET_CONFIG[Presets.STORAGE].queries as any)[key].safeSql([])
      expect(actual).toBe(expected)
    }
  })

  it('pg: cacheHitRate uses regexp_contains (starts_with pinned broken) and ordinal group/order', async () => {
    const { PRESET_CONFIG, Presets } = await loadPreset(...PG_SELF_PLATFORM)
    const sql: string = (PRESET_CONFIG[Presets.STORAGE].queries as any).cacheHitRate.safeSql([])
    expect(sql).not.toMatch(/starts_with/i)
    expect(sql).toMatch(/regexp_contains\(r\.path, '\^\/storage\/v1\/object'\)/i)
    expect(sql).toMatch(/group by 1\b/i)
    expect(sql).toMatch(/order by 1 desc/i)
  })

  it('pg: topCacheMisses uses regexp_contains and groups by 1,2 orders by 3 desc', async () => {
    const { PRESET_CONFIG, Presets } = await loadPreset(...PG_SELF_PLATFORM)
    const sql: string = (PRESET_CONFIG[Presets.STORAGE].queries as any).topCacheMisses.safeSql([])
    expect(sql).not.toMatch(/starts_with/i)
    expect(sql).toMatch(/regexp_contains\(r\.path, '\^\/storage\/v1\/object'\)/i)
    expect(sql).toMatch(/group by 1, 2\b/i)
    expect(sql).toMatch(/order by 3 desc/i)
  })
})

describe('Logs.utils genChartQuery dialect', () => {
  it('cloud: BQ text is byte-identical to the pre-M6.2 snapshot', async () => {
    const { LogsTableName, genChartQuery } = await loadGenChartQuery(...CLOUD)
    const sql = genChartQuery(
      LogsTableName.EDGE,
      {
        iso_timestamp_start: '2026-07-01T00:00:00.000Z',
        iso_timestamp_end: '2026-07-06T00:00:00.000Z',
      },
      {}
    )
    expect(sql).toBe(GEN_CHART_QUERY_BQ_SNAPSHOT)
  })

  it('pg: final fragment is GROUP BY 1 / ORDER BY 1 ASC', async () => {
    const { LogsTableName, genChartQuery } = await loadGenChartQuery(...PG_SELF_PLATFORM)
    const sql = genChartQuery(
      LogsTableName.EDGE,
      {
        iso_timestamp_start: '2026-07-01T00:00:00.000Z',
        iso_timestamp_end: '2026-07-06T00:00:00.000Z',
      },
      {}
    )
    expect(sql).toMatch(/GROUP BY 1\b/)
    expect(sql).toMatch(/ORDER BY 1 ASC/)
    expect(sql).not.toMatch(/GROUP BY\s*\n\s*timestamp/i)
  })
})
