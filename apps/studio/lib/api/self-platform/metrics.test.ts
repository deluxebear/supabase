import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  ATTRIBUTE_META,
  computeContainerAttributes,
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
  type Snapshot,
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
host_cpu_seconds_total{cpu="0",mode="io_wait"} 5
host_cpu_seconds_total{cpu="0",mode="irq"} 2
host_cpu_seconds_total{cpu="0",mode="soft_irq"} 3
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
host_cpu_seconds_total{cpu="0",mode="io_wait"} 8
host_cpu_seconds_total{cpu="0",mode="irq"} 3.8
host_cpu_seconds_total{cpu="0",mode="soft_irq"} 4.2
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
    expect(out.realtime_connections_connected).toBe(7)
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

describe('cadvisor fixture binds CONTAINER/MACHINE names', () => {
  const fixture = readFileSync(join(__dirname, '__fixtures__', 'cadvisor-scrape.prom'), 'utf8')
  const names = new Set(parsePrometheusText(fixture).map((s) => s.name))
  for (const n of [
    'container_cpu_usage_seconds_total',
    'container_cpu_user_seconds_total',
    'container_cpu_system_seconds_total',
    'container_memory_working_set_bytes',
    'container_network_receive_bytes_total',
    'container_network_transmit_bytes_total',
    'container_spec_memory_limit_bytes',
    'machine_cpu_cores',
    'machine_memory_bytes',
  ]) {
    it(`fixture has ${n}`, () => expect(names.has(n)).toBe(true))
  }
  it('the supabase-db container is identifiable by name label', () => {
    const s = parsePrometheusText(fixture).find(
      (x) => x.name === 'container_memory_working_set_bytes'
    )
    expect(s?.labels.name).toBe('supabase-db')
  })
})

describe('computeContainerAttributes', () => {
  const cont = (name: string, value: number, labels: Record<string, string> = {}) => ({
    name,
    labels: { name: 'supabase-db', ...labels },
    value,
  })
  const machine = [
    { name: 'machine_cpu_cores', labels: {}, value: 10 },
    { name: 'machine_memory_bytes', labels: {}, value: 1_000 },
  ]

  it('container CPU% uses machine cores as denominator', () => {
    const t0: Snapshot = {
      at: 0,
      samples: [
        cont('container_cpu_usage_seconds_total', 0),
        cont('container_cpu_user_seconds_total', 0),
        cont('container_cpu_system_seconds_total', 0),
        ...machine,
      ],
    }
    // 5 CPU-seconds used over 10s on a 10-core machine => 0.5 cores => 5%
    const t1: Snapshot = {
      at: 10_000,
      samples: [
        cont('container_cpu_usage_seconds_total', 5),
        cont('container_cpu_user_seconds_total', 3),
        cont('container_cpu_system_seconds_total', 2),
        ...machine,
      ],
    }
    const out = computeContainerAttributes(t0, t1, 'supabase-db')
    expect(out.avg_cpu_usage).toBeCloseTo(5)
    expect(out.max_cpu_usage).toBeCloseTo(5)
    expect(out.cpu_usage_busy_user).toBeCloseTo(3) // 3s/10s/10cores*100
    expect(out.cpu_usage_busy_system).toBeCloseTo(2)
    expect(out.cpu_usage_busy_other).toBeCloseTo(0)
    expect(out.cpu_usage_busy_iowait).toBeUndefined() // honest: cgroup has none
    expect(out.cpu_usage_busy_irqs).toBeUndefined()
  })

  it('container RAM% uses machine memory when no limit (limit=0)', () => {
    const s = [
      cont('container_memory_working_set_bytes', 200),
      cont('container_spec_memory_limit_bytes', 0),
      cont('container_memory_cache', 50),
      ...machine,
    ]
    const out = computeContainerAttributes(undefined, { at: 0, samples: s }, 'supabase-db')
    expect(out.ram_usage_used).toBe(200)
    expect(out.ram_usage_total).toBe(1_000) // machine_memory
    expect(out.ram_usage).toBeCloseTo(20)
    expect(out.ram_usage_free).toBe(800)
    expect(out.ram_usage_cache_and_buffers).toBe(50)
  })

  it('container RAM% uses the container limit when set below machine', () => {
    const s = [
      cont('container_memory_working_set_bytes', 200),
      cont('container_spec_memory_limit_bytes', 400),
      ...machine,
    ]
    const out = computeContainerAttributes(undefined, { at: 0, samples: s }, 'supabase-db')
    expect(out.ram_usage_total).toBe(400)
    expect(out.ram_usage).toBeCloseTo(50)
  })

  it('container network is a per-container rate', () => {
    const t0: Snapshot = {
      at: 0,
      samples: [
        cont('container_network_receive_bytes_total', 0),
        cont('container_network_transmit_bytes_total', 0),
        ...machine,
      ],
    }
    const t1: Snapshot = {
      at: 10_000,
      samples: [
        cont('container_network_receive_bytes_total', 1000),
        cont('container_network_transmit_bytes_total', 500),
        ...machine,
      ],
    }
    const out = computeContainerAttributes(t0, t1, 'supabase-db')
    expect(out.network_receive_bytes).toBeCloseTo(100)
    expect(out.network_transmit_bytes).toBeCloseTo(50)
  })

  it('filters to the named container (ignores other containers)', () => {
    const s = [
      cont('container_memory_working_set_bytes', 200, { name: 'supabase-db' }),
      { name: 'container_memory_working_set_bytes', labels: { name: 'supabase-kong' }, value: 999 },
      ...machine,
    ]
    const out = computeContainerAttributes(undefined, { at: 0, samples: s }, 'supabase-db')
    expect(out.ram_usage_used).toBe(200) // not 200+999
  })

  it('does not emit container disk-IO (honest: rootfs != data volume)', () => {
    const t0: Snapshot = {
      at: 0,
      samples: [cont('container_cpu_usage_seconds_total', 0), ...machine],
    }
    const t1: Snapshot = {
      at: 10_000,
      samples: [cont('container_cpu_usage_seconds_total', 1), ...machine],
    }
    const out = computeContainerAttributes(t0, t1, 'supabase-db')
    expect(out.disk_bytes_read).toBeUndefined()
    expect(out.disk_iops_read).toBeUndefined()
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
  it('both L1 statements failing drops all L1 attributes; L2 still written', async () => {
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
  it('WAL-only L1 failure: main-query attributes still written, WAL attribute dropped', async () => {
    // Distinguishes per-statement isolation from a merged try/catch: if the
    // two L1 queries were awaited inside a single try block and only
    // `collect()`-ed after both settled, a WAL-only failure would also drop
    // the main-query attributes (the throw happens before either collect()
    // call runs). The real code calls collect() right after each await
    // succeeds, in its own try/catch, so main attributes survive here.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: unknown, init?: { body?: string }) => {
        if (String(url).includes('/query')) {
          const isWal = String(init?.body ?? '').includes('pg_ls_waldir')
          if (isWal) throw new Error('wal query down')
          return { ok: true, status: 200, json: async () => [L1_ROW], text: async () => '' }
        }
        return { ok: true, status: 200, text: async () => PROM_T0, json: async () => [] }
      })
    )
    await sampleProject('proj-x')
    const insert = vi
      .mocked(executePlatformQuery)
      .mock.calls.find(([opts]) => opts.query.includes('insert into'))!
    const attrs = insert[0].parameters!.filter((p) => typeof p === 'string' && p !== 'proj-x')
    expect(attrs).toContain('pg_stat_database_num_backends')
    expect(attrs).toContain('pg_database_size')
    expect(attrs).not.toContain('disk_fs_used_wal')
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

describe('sampleProject — container dialect branch', () => {
  const CADVISOR = readFileSync(join(__dirname, '__fixtures__', 'cadvisor-scrape.prom'), 'utf8')
  const lastInsertAttrs = () => {
    const insert = vi
      .mocked(executePlatformQuery)
      .mock.calls.filter(([opts]) => opts.query.includes('insert into platform.metrics_samples'))
      .pop()!
    expect(insert).toBeTruthy()
    return insert[0].parameters!
  }

  it('containerName set → container_* dialect (machine-denominator RAM/CPU from cAdvisor)', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      ...CONN,
      containerName: 'supabase-db',
    } as never)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: unknown) => {
        if (String(url).includes('/query')) {
          return { ok: true, status: 200, json: async () => [{}], text: async () => '' }
        }
        return { ok: true, status: 200, text: async () => CADVISOR, json: async () => [] }
      })
    )
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    await sampleProject('proj-x') // first cycle: seeds lastScrape (prev)
    nowSpy.mockReturnValue(1_060_000) // +60s
    await sampleProject('proj-x') // second cycle: CPU/network rates now available
    const params = lastInsertAttrs()
    const attrs = params.filter((p) => typeof p === 'string' && p !== 'proj-x')
    expect(attrs).toContain('ram_usage') // container memory %
    expect(attrs).toContain('ram_usage_used')
    expect(attrs).toContain('avg_cpu_usage') // container CPU rate (needs prev)
    // ram_usage_used is the container working-set, not any host-memory value.
    const i = params.indexOf('ram_usage_used')
    expect(params[i + 1]).toBe(164704256)
    // Only ATTRIBUTE_META keys are ever inserted (injection-barrier invariant).
    expect(attrs.every((a) => (a as string) in ATTRIBUTE_META)).toBe(true)
    nowSpy.mockRestore()
  })

  it('containerName null → host dialect (existing computeScrapeAttributes path)', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      ...CONN,
      containerName: null,
    } as never)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: unknown) => {
        if (String(url).includes('/query')) {
          return { ok: true, status: 200, json: async () => [{}], text: async () => '' }
        }
        return { ok: true, status: 200, text: async () => PROM_T0, json: async () => [] }
      })
    )
    await sampleProject('proj-x')
    const params = lastInsertAttrs()
    const attrs = params.filter((p) => typeof p === 'string' && p !== 'proj-x')
    expect(attrs).toContain('ram_usage')
    const i = params.indexOf('ram_usage_used')
    expect(params[i + 1]).toBe(500) // host math: 1000-300-150-50, NOT a container value
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
