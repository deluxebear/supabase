import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  ATTRIBUTE_META,
  computeScrapeAttributes,
  METRICS_RETENTION_DAYS,
  parsePrometheusText,
  resetMetricsSamplerForTest,
  runSamplerCycle,
  sampleProject,
  startMetricsSampler,
  SWEEP_MIN_INTERVAL_MS,
  sweepIfDue,
  type PromSample,
} from './metrics'
import { resolveProjectConnection } from './resolve-connection'

vi.mock('./resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('@/lib/api/apiHelpers', () => ({
  constructHeaders: vi.fn((h: Record<string, string>) => h),
}))

const CONN = {
  ref: 'proj-x',
  pgConnEncrypted: 'enc-dsn',
  metricsUrl: 'http://stack:9598/metrics',
  metricsToken: null,
} as unknown as Awaited<ReturnType<typeof resolveProjectConnection>>

const snap = (at: number, text: string) => ({ at, samples: parsePrometheusText(text) })

const PROM_T0 = `
host_cpu_seconds_total{cpu="0",mode="idle"} 900
host_cpu_seconds_total{cpu="0",mode="system"} 40
host_cpu_seconds_total{cpu="0",mode="user"} 50
host_cpu_seconds_total{cpu="0",mode="nice"} 0
host_cpu_seconds_total{cpu="0",mode="iowait"} 5
host_cpu_seconds_total{cpu="0",mode="irq"} 2
host_cpu_seconds_total{cpu="0",mode="softirq"} 3
host_memory_total_bytes 1000
host_memory_free_bytes 300
host_memory_cached_bytes 150
host_memory_buffers_bytes 50
host_memory_swap_used_bytes 25
host_memory_swap_total_bytes 100
host_filesystem_total_bytes{mountpoint="/"} 5000
host_filesystem_used_bytes{mountpoint="/"} 2000
host_network_receive_bytes_total{device="eth0"} 1000
host_network_receive_bytes_total{device="lo"} 99999
host_network_transmit_bytes_total{device="eth0"} 500
host_disk_read_bytes_total{device="vda"} 4000
host_disk_written_bytes_total{device="vda"} 8000
host_disk_reads_completed_total{device="vda"} 100
host_disk_writes_completed_total{device="vda"} 200
realtime_connections_connected 7
`
// 60s later: +60s cpu total spread as idle+30 system+12 user+12 iowait+3 irq+1.8 softirq+1.2
const PROM_T1 = `
host_cpu_seconds_total{cpu="0",mode="idle"} 930
host_cpu_seconds_total{cpu="0",mode="system"} 52
host_cpu_seconds_total{cpu="0",mode="user"} 62
host_cpu_seconds_total{cpu="0",mode="nice"} 0
host_cpu_seconds_total{cpu="0",mode="iowait"} 8
host_cpu_seconds_total{cpu="0",mode="irq"} 3.8
host_cpu_seconds_total{cpu="0",mode="softirq"} 4.2
host_memory_total_bytes 1000
host_memory_free_bytes 300
host_memory_cached_bytes 150
host_memory_buffers_bytes 50
host_memory_swap_used_bytes 25
host_memory_swap_total_bytes 100
host_filesystem_total_bytes{mountpoint="/"} 5000
host_filesystem_used_bytes{mountpoint="/"} 2000
host_network_receive_bytes_total{device="eth0"} 61000
host_network_receive_bytes_total{device="lo"} 199999
host_network_transmit_bytes_total{device="eth0"} 30500
host_disk_read_bytes_total{device="vda"} 64000
host_disk_written_bytes_total{device="vda"} 68000
host_disk_reads_completed_total{device="vda"} 400
host_disk_writes_completed_total{device="vda"} 800
realtime_connections_connected 9
`

beforeEach(() => {
  resetMetricsSamplerForTest()
  vi.mocked(resolveProjectConnection).mockReset().mockResolvedValue(CONN)
  vi.mocked(executePlatformQuery).mockReset().mockResolvedValue({ data: [], error: undefined })
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => PROM_T0, json: async () => [] })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('parsePrometheusText', () => {
  it('parses names, labels, values; skips comments/blank/NaN; tolerates timestamps', () => {
    const samples = parsePrometheusText(
      '# HELP x y\n\nfoo{a="b",c="d\\"e"} 1.5 1751760000000\nbar 2\nbroken NaN\n'
    )
    expect(samples).toEqual([
      { name: 'foo', labels: { a: 'b', c: 'd"e' }, value: 1.5 },
      { name: 'bar', labels: {}, value: 2 },
    ] satisfies PromSample[])
  })
})

describe('computeScrapeAttributes', () => {
  it('first cycle (no prev): gauges present, rates and cpu absent', () => {
    const out = computeScrapeAttributes(undefined, snap(60_000, PROM_T0))
    expect(out.ram_usage_total).toBe(1000)
    expect(out.ram_usage_used).toBe(500) // 1000-300-150-50
    expect(out.ram_usage_cache_and_buffers).toBe(200)
    expect(out.ram_usage).toBe(50)
    expect(out.ram_usage_swap).toBe(25)
    expect(out.swap_usage).toBe(25)
    expect(out.disk_fs_size).toBe(5000)
    expect(out.disk_fs_used).toBe(2000)
    expect(out.realtime_sum_connections_connected).toBe(7)
    expect(out.avg_cpu_usage).toBeUndefined()
    expect(out.network_receive_bytes).toBeUndefined()
  })
  it('second cycle: exact rate and cpu-mode math over 60s', () => {
    const prev = snap(0, PROM_T0)
    const out = computeScrapeAttributes(prev, snap(60_000, PROM_T1))
    expect(out.network_receive_bytes).toBe(1000) // (61000-1000)/60, lo excluded
    expect(out.network_transmit_bytes).toBe(500)
    expect(out.disk_bytes_read).toBe(1000)
    expect(out.disk_bytes_written).toBe(1000)
    expect(out.disk_iops_read).toBe(5)
    expect(out.disk_iops_write).toBe(10)
    // cpu deltas: total 60; system 12=20%, user 12=20%, iowait 3=5%, irqs 3=5%, idle 30=50%
    expect(out.cpu_usage_busy_system).toBeCloseTo(20, 5)
    expect(out.cpu_usage_busy_user).toBeCloseTo(20, 5)
    expect(out.cpu_usage_busy_iowait).toBeCloseTo(5, 5)
    expect(out.cpu_usage_busy_irqs).toBeCloseTo(5, 5)
    expect(out.avg_cpu_usage).toBeCloseTo(50, 5)
    expect(out.max_cpu_usage).toBeCloseTo(50, 5)
    expect(out.cpu_usage_busy_other).toBeCloseTo(0, 5)
  })
  it('counter reset (negative delta): rate/cpu attributes skipped, gauges kept', () => {
    const out = computeScrapeAttributes(snap(0, PROM_T1), snap(60_000, PROM_T0))
    expect(out.network_receive_bytes).toBeUndefined()
    expect(out.avg_cpu_usage).toBeUndefined()
    expect(out.ram_usage_total).toBe(1000)
  })
})

describe('fixture (T1 name pins are binding)', () => {
  it('every HOST source name appears in the committed fixture', () => {
    const fixture = readFileSync(join(__dirname, '__fixtures__', 'metrics-scrape.prom'), 'utf8')
    const names = new Set(parsePrometheusText(fixture).map((s) => s.name))
    for (const name of [
      'host_cpu_seconds_total',
      'host_memory_total_bytes',
      'host_memory_free_bytes',
      'host_memory_cached_bytes',
      'host_memory_buffers_bytes',
      'host_memory_swap_used_bytes',
      'host_memory_swap_total_bytes',
      'host_filesystem_total_bytes',
      'host_filesystem_used_bytes',
      'host_network_receive_bytes_total',
      'host_network_transmit_bytes_total',
      'host_disk_read_bytes_total',
      'host_disk_written_bytes_total',
      'host_disk_reads_completed_total',
      'host_disk_writes_completed_total',
    ]) {
      expect(
        names,
        `fixture missing ${name} — update HOST constant to the fixture's name`
      ).toContain(name)
    }
  })
})

describe('sampleProject', () => {
  const L1_ROW = {
    pg_stat_database_num_backends: 3,
    client_connections_postgres: 1,
    client_connections_authenticator: 0,
    client_connections_supabase_admin: 1,
    client_connections_supabase_auth_admin: 0,
    client_connections_supabase_storage_admin: 0,
    client_connections_other: 1,
    pg_database_size: 900,
  }
  const WAL_ROW = { disk_fs_used_wal: 100 }
  const pgMetaMock = (main: unknown, wal: unknown) =>
    vi.fn().mockImplementation(async (url: unknown, init?: { body?: string }) => {
      if (String(url).includes('/query')) {
        const isWal = String(init?.body ?? '').includes('pg_ls_waldir')
        return {
          ok: true,
          status: 200,
          json: async () => [isWal ? wal : main],
          text: async () => '',
        }
      }
      return { ok: true, status: 200, text: async () => PROM_T0, json: async () => [] }
    })

  it('writes L1+L2+derived values in one parameterized insert', async () => {
    vi.stubGlobal('fetch', pgMetaMock(L1_ROW, WAL_ROW))
    await sampleProject('proj-x')
    const insert = vi
      .mocked(executePlatformQuery)
      .mock.calls.find(([opts]) => opts.query.includes('insert into platform.metrics_samples'))!
    expect(insert).toBeTruthy()
    const [opts] = insert
    expect(opts.parameters![0]).toBe('proj-x')
    const attrs = opts.parameters!.filter((p) => typeof p === 'string' && p !== 'proj-x')
    expect(attrs).toContain('pg_stat_database_num_backends')
    expect(attrs).toContain('ram_usage')
    expect(attrs).toContain('disk_fs_used_system')
    const i = opts.parameters!.indexOf('disk_fs_used_system')
    expect(opts.parameters![i + 1]).toBe(1000) // 2000 - 900 - 100
    expect(attrs.every((a) => (a as string) in ATTRIBUTE_META || a === 'proj-x')).toBe(true)
  })
  it('L1 failure drops only its attributes; L2 still written', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: unknown) => {
        if (String(url).includes('/query')) throw new Error('pg-meta down')
        return { ok: true, status: 200, text: async () => PROM_T0, json: async () => [] }
      })
    )
    await sampleProject('proj-x')
    const insert = vi
      .mocked(executePlatformQuery)
      .mock.calls.find(([opts]) => opts.query.includes('insert into'))!
    const attrs = insert[0].parameters!.filter((p) => typeof p === 'string' && p !== 'proj-x')
    expect(attrs).toContain('ram_usage')
    expect(attrs).not.toContain('pg_stat_database_num_backends')
  })
  it('metricsUrl null → no scrape fetch, L1-only insert', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({ ...CONN, metricsUrl: null } as never)
    vi.stubGlobal('fetch', pgMetaMock(L1_ROW, WAL_ROW))
    await sampleProject('proj-x')
    const scrapes = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes(':9598'))
    expect(scrapes).toHaveLength(0)
    const insert = vi
      .mocked(executePlatformQuery)
      .mock.calls.find(([opts]) => opts.query.includes('insert into'))!
    const attrs = insert[0].parameters!.filter((p) => typeof p === 'string' && p !== 'proj-x')
    expect(attrs).toContain('pg_database_size')
    expect(attrs).not.toContain('ram_usage')
  })
  it('sends Bearer when metricsToken set', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      ...CONN,
      metricsToken: 'mtok',
    } as never)
    vi.stubGlobal('fetch', pgMetaMock(L1_ROW, WAL_ROW))
    await sampleProject('proj-x')
    const scrape = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes(':9598'))!
    expect((scrape[1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer mtok'
    )
  })
})

describe('runSamplerCycle', () => {
  it('per-row isolation: one row failing does not stop the other', async () => {
    vi.mocked(executePlatformQuery).mockImplementation(async ({ query }) => {
      if (query.startsWith('select ref')) {
        return { data: [{ ref: 'bad' }, { ref: 'good' }] as never, error: undefined }
      }
      return { data: [], error: undefined }
    })
    vi.mocked(resolveProjectConnection).mockImplementation(async (ref: string) => {
      if (ref === 'bad') throw new Error('row exploded')
      return CONN
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runSamplerCycle()
    expect(vi.mocked(resolveProjectConnection)).toHaveBeenCalledWith('good')
    expect(warn.mock.calls.some(([m]) => String(m).includes('"bad"'))).toBe(true)
    warn.mockRestore()
  })
  it('overlap guard: concurrent second call is a no-op', async () => {
    let resolveList: (v: { data: never[]; error: undefined }) => void
    vi.mocked(executePlatformQuery).mockImplementation(({ query }) =>
      query.startsWith('select ref')
        ? (new Promise((r) => (resolveList = r)) as never)
        : Promise.resolve({ data: [], error: undefined })
    )
    const first = runSamplerCycle()
    await runSamplerCycle() // returns immediately — cycleRunning
    resolveList!({ data: [], error: undefined })
    await first
    const listCalls = vi
      .mocked(executePlatformQuery)
      .mock.calls.filter(([o]) => o.query.startsWith('select ref'))
    expect(listCalls).toHaveLength(1)
  })
})

describe('sweepIfDue', () => {
  it('rate-limited to SWEEP_MIN_INTERVAL_MS and uses the retention constant', async () => {
    await sweepIfDue(1_000_000)
    await sweepIfDue(1_000_000 + SWEEP_MIN_INTERVAL_MS - 1)
    await sweepIfDue(1_000_000 + SWEEP_MIN_INTERVAL_MS)
    const deletes = vi
      .mocked(executePlatformQuery)
      .mock.calls.filter(([o]) => o.query.includes('delete from platform.metrics_samples'))
    expect(deletes).toHaveLength(2)
    expect(deletes[0][0].query).toContain(`interval '${METRICS_RETENTION_DAYS} days'`)
  })
})

describe('startMetricsSampler', () => {
  it('is idempotent (one interval) and fires an immediate cycle', async () => {
    vi.useFakeTimers()
    startMetricsSampler()
    startMetricsSampler()
    expect(vi.getTimerCount()).toBe(1)
    await vi.runOnlyPendingTimersAsync()
  })
})
