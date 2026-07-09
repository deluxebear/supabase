import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { get, post } from '@/data/fetchers'

vi.mock('@/data/fetchers', () => ({
  get: vi.fn(),
  post: vi.fn(),
  handleError: vi.fn(),
}))

type PostResponse = Awaited<ReturnType<typeof post>>
type GetResponse = Awaited<ReturnType<typeof get>>

// [self-platform] M6.3: USE_LOGFLARE_PG_SQL (data/logs/logflare-dialect.ts) is
// a module-scope const resolved from NEXT_PUBLIC_IS_PLATFORM /
// NEXT_PUBLIC_SELF_PLATFORM at import time — vi.stubEnv alone cannot change
// an already-evaluated top-level const, so the SUT must be freshly
// re-imported per test (same idiom as logflare-dialect.test.ts /
// report-sql.pg-dialect.test.ts's loadDialect/loadShared helpers).
// `vi.doUnmock('common')` undoes tests/vitestSetup.ts's global `common` mock
// (its factory spreads a memoized `importOriginal()` result across
// `vi.resetModules()` — a vite-node quirk — so re-stubbing
// NEXT_PUBLIC_IS_PLATFORM would otherwise silently keep resolving
// IS_PLATFORM to whatever the first test saw). `@/data/fetchers` is NOT
// unmocked — `vi.mock`'d modules are stable singletons for the whole file
// regardless of `resetModules()`, so the top-level `get`/`post` mocks above
// stay the exact instances the freshly re-imported SUT resolves to.
async function loadSut(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  const { getEdgeFunctionsLastHourStats } = await import('./edge-functions-last-hour-stats-query')
  return getEdgeFunctionsLastHourStats
}

const CLOUD = ['true', ''] as const
const PG_SELF_PLATFORM = ['true', 'true'] as const

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getEdgeFunctionsLastHourStats (cloud: BQ SQL via logs.all)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
    vi.mocked(post).mockReset()
    vi.mocked(get).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requests last-hour function stats from logs.all by default', async () => {
    const getEdgeFunctionsLastHourStats = await loadSut(...CLOUD)
    vi.mocked(post).mockResolvedValue({ data: { result: [] }, error: null } as PostResponse)

    await getEdgeFunctionsLastHourStats({
      projectRef: 'project-ref',
      functionIds: ['fn_1', 'fn_2'],
    })

    expect(post).toHaveBeenCalledWith('/platform/projects/{ref}/analytics/endpoints/logs.all', {
      params: {
        path: { ref: 'project-ref' },
        query: { key: 'last-hour-stats' },
      },
      body: expect.objectContaining({
        sql: expect.stringContaining(`and function_id in ('fn_1', 'fn_2')`),
        iso_timestamp_start: '2024-01-15T11:00:00.000Z',
        iso_timestamp_end: '2024-01-15T12:00:00.000Z',
      }),
      signal: undefined,
    })

    const postCalls = vi.mocked(post).mock.calls as Array<
      [string, { body?: { sql?: string } } | undefined]
    >

    expect(postCalls[0]?.[1]?.body?.sql).toContain('from\n  function_edge_logs')
  })

  it('requests last-hour function stats from logs.all.otel when useOtel is set', async () => {
    const getEdgeFunctionsLastHourStats = await loadSut(...CLOUD)
    vi.mocked(post).mockResolvedValue({ data: { result: [] }, error: null } as PostResponse)

    await getEdgeFunctionsLastHourStats({
      projectRef: 'project-ref',
      functionIds: ['fn_1', 'fn_2'],
      useOtel: true,
    })

    expect(post).toHaveBeenCalledWith(
      '/platform/projects/{ref}/analytics/endpoints/logs.all.otel',
      {
        params: {
          path: { ref: 'project-ref' },
          query: { key: 'last-hour-stats' },
        },
        body: expect.objectContaining({
          sql: expect.stringContaining(`and log_attributes['function_id'] in ('fn_1', 'fn_2')`),
          iso_timestamp_start: '2024-01-15T11:00:00.000Z',
          iso_timestamp_end: '2024-01-15T12:00:00.000Z',
        }),
        signal: undefined,
      }
    )

    const postCalls = vi.mocked(post).mock.calls as Array<
      [string, { body?: { sql?: string } } | undefined]
    >
    const sql = postCalls[0]?.[1]?.body?.sql ?? ''

    expect(sql).toContain('from logs')
    expect(sql).toContain("source = 'function_edge_logs'")
    expect(sql).toContain("case when toInt32OrZero(log_attributes['response.status_code']) >= 500")
    expect(sql).not.toContain('cross join unnest')
  })

  it('coerces counts to numbers and computes error rates per function', async () => {
    const getEdgeFunctionsLastHourStats = await loadSut(...CLOUD)
    vi.mocked(post).mockResolvedValue({
      data: {
        result: [
          { function_id: 'fn_1', requests_count: '100', server_err_count: '5' },
          { function_id: 'fn_2', requests_count: 8, server_err_count: 0 },
        ],
      },
      error: null,
    } as PostResponse)

    const result = await getEdgeFunctionsLastHourStats({
      projectRef: 'project-ref',
      functionIds: ['fn_1', 'fn_2'],
    })

    expect(result).toEqual({
      fn_1: {
        functionId: 'fn_1',
        requestsCount: 100,
        serverErrorCount: 5,
        errorRate: 5,
      },
      fn_2: {
        functionId: 'fn_2',
        requestsCount: 8,
        serverErrorCount: 0,
        errorRate: 0,
      },
    })
  })

  it('handles empty results', async () => {
    const getEdgeFunctionsLastHourStats = await loadSut(...CLOUD)
    vi.mocked(post).mockResolvedValue({ data: { result: [] }, error: null } as PostResponse)

    const result = await getEdgeFunctionsLastHourStats({
      projectRef: 'project-ref',
      functionIds: ['fn_1'],
    })

    expect(result).toEqual({})
  })

  it('skips the logs query when there are no function ids', async () => {
    const getEdgeFunctionsLastHourStats = await loadSut(...CLOUD)

    const result = await getEdgeFunctionsLastHourStats({
      projectRef: 'project-ref',
      functionIds: [],
    })

    expect(result).toEqual({})
    expect(post).not.toHaveBeenCalled()
  })
})

describe('getEdgeFunctionsLastHourStats (self-hosted PG dialect, M6.3 fold-in)', () => {
  beforeEach(() => {
    vi.mocked(post).mockReset()
    vi.mocked(get).mockReset()
  })

  it('routes through the named substitute endpoint when USE_LOGFLARE_PG_SQL, and never calls the BQ logs.all path', async () => {
    const getEdgeFunctionsLastHourStats = await loadSut(...PG_SELF_PLATFORM)
    vi.mocked(get).mockResolvedValue({ data: { result: [] }, error: undefined } as GetResponse)

    const result = await getEdgeFunctionsLastHourStats({
      projectRef: 'project-ref',
      functionIds: ['fn_1', 'fn_2'],
    })

    // honest empty — consumer-safe (same shape a zero-row cloud response produces)
    expect(result).toEqual({})
    expect(post).not.toHaveBeenCalled()

    const [path, init] = vi.mocked(get).mock.calls.at(-1)! as [string, unknown]
    expect(path).toContain('/analytics/endpoints/functions.last-hour-stats')
    expect((init as { params?: { path?: { ref?: string } } })?.params?.path?.ref).toBe(
      'project-ref'
    )
  })
})
