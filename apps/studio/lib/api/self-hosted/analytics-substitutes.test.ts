import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearSubstituteCache,
  InvalidAnalyticsParams,
  isSubstitutedEndpoint,
  retrieveSubstitutedAnalyticsData,
} from './analytics-substitutes'

// [self-platform] vi.hoisted required here (not a plain top-level const):
// vi.mock's factory runs before this file's own top-level statements
// (ES import hoisting resolves './analytics-substitutes' → './logs' ahead
// of any local const), so a non-"mock"-prefixed identifier hits the TDZ.
// Same idiom as per-ref.test.ts's './logs' mock. Test semantics unchanged.
const { retrieveAnalyticsData } = vi.hoisted(() => ({ retrieveAnalyticsData: vi.fn() }))
vi.mock('./logs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveAnalyticsData,
}))

const ok = (rows: unknown[]) => ({ data: { result: rows }, error: undefined })

beforeEach(() => {
  clearSubstituteCache()
  retrieveAnalyticsData.mockReset().mockResolvedValue(ok([]))
})
afterEach(() => vi.useRealTimers())

describe('isSubstitutedEndpoint', () => {
  it('matches exactly the four names', () => {
    for (const n of [
      'usage.api-counts',
      'service-health',
      'auth.metrics',
      'functions.combined-stats',
    ])
      expect(isSubstitutedEndpoint(n)).toBe(true)
    for (const n of ['logs.all', 'logs.all.otel', 'usage.api-counts2', ''])
      expect(isSubstitutedEndpoint(n)).toBe(false)
  })
})

describe('usage.api-counts substitute', () => {
  it('maps 1hr → minute buckets over the last hour, forwards via logs.all sandbox SQL', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-06T10:00:00.000Z'))
    retrieveAnalyticsData.mockResolvedValue(
      ok([
        {
          timestamp: 1783263600000000,
          total_rest_requests: 3,
          total_auth_requests: 1,
          total_storage_requests: 0,
          total_realtime_requests: 0,
        },
      ])
    )
    const { data } = await retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '1hr' },
    })
    const call = retrieveAnalyticsData.mock.calls[0][0]
    expect(call.name).toBe('logs.all')
    expect(call.projectRef).toBe('default')
    expect(call.params.iso_timestamp_start).toBe('2026-07-06T09:00:00.000Z')
    expect(call.params.sql).toContain('timestamp_trunc(t.timestamp, minute)')
    expect(call.params.sql).toContain("regexp_contains(r.path, '^/rest/')")
    // dialect discipline: ordinals only, no datetime cast, no novel/shadow alias group-by
    expect(call.params.sql).toMatch(/group by 1\b/)
    expect(call.params.sql).not.toMatch(/as datetime/i)
    expect(call.params.sql).not.toMatch(/group by timestamp/i)
    // reshape: micros → ISO string (UsageApiCounts.timestamp is a string)
    expect(data?.result?.[0].timestamp).toBe('2026-07-05T15:00:00.000Z')
    expect(data?.result?.[0].total_rest_requests).toBe(3)
  })

  it('1day → hour buckets over 24h; 7day → day buckets over 7d', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-06T10:00:00.000Z'))
    await retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '1day' },
    })
    expect(retrieveAnalyticsData.mock.calls[0][0].params.iso_timestamp_start).toBe(
      '2026-07-05T10:00:00.000Z'
    )
    expect(retrieveAnalyticsData.mock.calls[0][0].params.sql).toContain(
      'timestamp_trunc(t.timestamp, hour)'
    )
    clearSubstituteCache()
    await retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '7day' },
    })
    expect(retrieveAnalyticsData.mock.calls[1][0].params.iso_timestamp_start).toBe(
      '2026-06-29T10:00:00.000Z'
    )
    expect(retrieveAnalyticsData.mock.calls[1][0].params.sql).toContain(
      'timestamp_trunc(t.timestamp, day)'
    )
  })

  it('unknown interval → InvalidAnalyticsParams, no wire call', async () => {
    await expect(
      retrieveSubstitutedAnalyticsData({
        name: 'usage.api-counts',
        projectRef: 'default',
        params: { interval: 'wat' },
      })
    ).rejects.toBeInstanceOf(InvalidAnalyticsParams)
    expect(retrieveAnalyticsData).not.toHaveBeenCalled()
  })
})

describe('service-health substitute', () => {
  it('runs one classified query per service table (UNION ALL is broken on the PG translator) and merges into nested rows', async () => {
    retrieveAnalyticsData.mockImplementation(async ({ params }: any) => {
      if (params.sql.includes('from edge_logs'))
        return ok([{ timestamp: 1783263600000000, error: 1, warning: 2, total: 10 }])
      if (params.sql.includes('from auth_logs'))
        return ok([{ timestamp: 1783263600000000, error: 0, warning: 0, total: 3 }])
      return ok([])
    })
    const { data } = await retrieveSubstitutedAnalyticsData({
      name: 'service-health',
      projectRef: 'default',
      params: {
        iso_timestamp_start: '2026-07-06T09:00:00.000Z',
        iso_timestamp_end: '2026-07-06T10:00:00.000Z',
        granularity: 'hour',
      },
    })
    // 7 tables probed: edge, function_edge, auth, postgres (classified) + storage, realtime, postgrest (total-only)
    expect(retrieveAnalyticsData).toHaveBeenCalledTimes(7)
    for (const [{ params }] of retrieveAnalyticsData.mock.calls.map((c: any) => c)) {
      expect(params.iso_timestamp_start).toBe('2026-07-06T09:00:00.000Z')
      expect(params.iso_timestamp_end).toBe('2026-07-06T10:00:00.000Z')
      expect(params.sql).toMatch(/group by 1\b/)
      expect(params.sql).not.toMatch(/union all/i)
    }
    const row = data?.result?.[0]
    expect(row.timestamp).toBe('2026-07-05T15:00:00.000Z')
    expect(row.edge_logs).toEqual({ ok: 7, warning: 2, error: 1, total: 10 })
    expect(row.auth_logs).toEqual({ ok: 3, warning: 0, error: 0, total: 3 })
    // tables with no rows in this bucket → zeroed object (consumer optional-chains anyway)
    expect(row.storage_logs).toEqual({ ok: 0, warning: 0, error: 0, total: 0 })
  })

  it('invalid granularity → InvalidAnalyticsParams; ok never negative (clamped)', async () => {
    await expect(
      retrieveSubstitutedAnalyticsData({
        name: 'service-health',
        projectRef: 'default',
        params: { granularity: 'week' },
      })
    ).rejects.toBeInstanceOf(InvalidAnalyticsParams)
    retrieveAnalyticsData.mockResolvedValue(
      ok([{ timestamp: 1783263600000000, error: 9, warning: 9, total: 10 }])
    )
    const { data } = await retrieveSubstitutedAnalyticsData({
      name: 'service-health',
      projectRef: 'default',
      params: { granularity: 'hour' },
    })
    expect(data?.result?.[0].edge_logs.ok).toBe(0)
  })
})

describe('promise-TTL cache', () => {
  it('identical params within TTL share one underlying run (absorbs the 7× frontend fan-out)', async () => {
    const p1 = retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '1hr' },
    })
    const p2 = retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '1hr' },
    })
    await Promise.all([p1, p2])
    expect(retrieveAnalyticsData).toHaveBeenCalledTimes(1)
  })
  it('different ref or params bypass the cache', async () => {
    await retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '1hr' },
    })
    await retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'proj-b',
      params: { interval: '1hr' },
    })
    await retrieveSubstitutedAnalyticsData({
      name: 'usage.api-counts',
      projectRef: 'default',
      params: { interval: '1day' },
    })
    expect(retrieveAnalyticsData).toHaveBeenCalledTimes(3)
  })
})

describe('auth.metrics substitute', () => {
  it('produces current+previous rows matching RawAuthMetricsRowSchema keys', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-06T10:00:00.000Z'))
    retrieveAnalyticsData.mockResolvedValue(
      ok([
        {
          active_users: 2,
          sign_up_count: 1,
          password_reset_requests: 0,
          auth_total_errors: 0,
          auth_total_requests: 5,
          api_error_requests: 1,
          api_total_requests: 9,
        },
      ])
    )
    const { data } = await retrieveSubstitutedAnalyticsData({
      name: 'auth.metrics',
      projectRef: 'default',
      params: { interval: '1day' },
    })
    const rows = data?.result as any[]
    expect(rows.map((r) => r.period)).toEqual(['current', 'previous'])
    for (const r of rows)
      for (const k of [
        'active_users',
        'api_error_requests',
        'api_total_requests',
        'auth_total_errors',
        'auth_total_requests',
        'password_reset_requests',
        'sign_up_count',
      ])
        expect(typeof r[k]).toBe('number')
    // 2 windows × 2 tables (auth_logs + edge_logs)
    expect(retrieveAnalyticsData).toHaveBeenCalledTimes(4)
    const starts = retrieveAnalyticsData.mock.calls.map((c: any) => c[0].params.iso_timestamp_start)
    expect(starts).toContain('2026-07-05T10:00:00.000Z') // current window start
    expect(starts).toContain('2026-07-04T10:00:00.000Z') // previous window start
  })
})

describe('functions.combined-stats substitute', () => {
  it('validates function_id (injection rejected before any wire call)', async () => {
    await expect(
      retrieveSubstitutedAnalyticsData({
        name: 'functions.combined-stats',
        projectRef: 'default',
        params: { function_id: "x' or '1'='1", interval: '1hr' },
      })
    ).rejects.toBeInstanceOf(InvalidAnalyticsParams)
    expect(retrieveAnalyticsData).not.toHaveBeenCalled()
  })
  it('two queries (function_edge_logs + function_logs) merged by bucket; missing metrics omitted (frontend zero-fills)', async () => {
    retrieveAnalyticsData.mockImplementation(async ({ params }: any) =>
      params.sql.includes('from function_edge_logs')
        ? ok([
            {
              timestamp: 1783263600000000,
              requests_count: 4,
              success_count: 4,
              redirect_count: 0,
              client_err_count: 0,
              server_err_count: 0,
              avg_execution_time: 12.5,
              max_execution_time: 30,
            },
          ])
        : ok([
            {
              timestamp: 1783263600000000,
              log_count: 6,
              log_info_count: 5,
              log_warn_count: 1,
              log_error_count: 0,
            },
          ])
    )
    const { data } = await retrieveSubstitutedAnalyticsData({
      name: 'functions.combined-stats',
      projectRef: 'default',
      params: { function_id: 'fn-uuid-1', interval: '1hr' },
    })
    expect(retrieveAnalyticsData).toHaveBeenCalledTimes(2)
    for (const [{ params }] of retrieveAnalyticsData.mock.calls.map((c: any) => c))
      expect(params.sql).toContain("'fn-uuid-1'")
    const row = data?.result?.[0]
    expect(row.timestamp).toBe('2026-07-05T15:00:00.000Z')
    expect(row.requests_count).toBe(4)
    expect(row.log_count).toBe(6)
    expect(row.avg_cpu_time_used).toBeUndefined() // not derivable self-hosted; useFillTimeseriesSorted defaults 0
  })
})
