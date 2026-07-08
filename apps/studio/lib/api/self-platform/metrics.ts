// [self-platform] M6.3: resident infra-metrics sampler + Prometheus→attribute
// adapter. Cashes in the M6.0 D1 poller slot: a 60s loop samples every
// registered row (L1 SQL always; L2 scrape when metrics_url is set), computes
// FINAL gauge/rate values, and writes them to platform.metrics_samples.
// Routes are pure bucket-aggregations over that table — no math downstream.
import { executePlatformQuery } from './db'
import { resolveProjectConnection } from './resolve-connection'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { PG_META_URL } from '@/lib/constants'

export const METRICS_SAMPLE_INTERVAL_MS = 60_000
export const METRICS_RETENTION_DAYS = 7
export const METRICS_SCRAPE_TIMEOUT_MS = 15_000
export const METRICS_L1_TIMEOUT_MS = 5_000
export const SWEEP_MIN_INTERVAL_MS = 3_600_000

export interface AttributeMeta {
  format: '%' | 'bytes' | 'bytes-per-second' | ''
  yAxisLimit: number
  /** How the route folds bucket values into `series[attr].total`. */
  total: 'sum' | 'latest'
}

// Everything this milestone can serve. Route-side whitelist: requested
// attributes outside this table return empty series (honest, no 404 wall).
export const ATTRIBUTE_META: Record<string, AttributeMeta> = {
  cpu_usage_busy_system: { format: '%', yAxisLimit: 100, total: 'latest' },
  cpu_usage_busy_user: { format: '%', yAxisLimit: 100, total: 'latest' },
  cpu_usage_busy_iowait: { format: '%', yAxisLimit: 100, total: 'latest' },
  cpu_usage_busy_irqs: { format: '%', yAxisLimit: 100, total: 'latest' },
  cpu_usage_busy_other: { format: '%', yAxisLimit: 100, total: 'latest' },
  avg_cpu_usage: { format: '%', yAxisLimit: 100, total: 'latest' },
  max_cpu_usage: { format: '%', yAxisLimit: 100, total: 'latest' },
  ram_usage: { format: '%', yAxisLimit: 100, total: 'latest' },
  ram_usage_total: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  ram_usage_used: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  ram_usage_free: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  ram_usage_cache_and_buffers: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  ram_usage_swap: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  swap_usage: { format: '%', yAxisLimit: 100, total: 'latest' },
  network_receive_bytes: { format: 'bytes-per-second', yAxisLimit: 0, total: 'sum' },
  network_transmit_bytes: { format: 'bytes-per-second', yAxisLimit: 0, total: 'sum' },
  disk_bytes_read: { format: 'bytes-per-second', yAxisLimit: 0, total: 'sum' },
  disk_bytes_written: { format: 'bytes-per-second', yAxisLimit: 0, total: 'sum' },
  disk_iops_read: { format: '', yAxisLimit: 0, total: 'sum' },
  disk_iops_write: { format: '', yAxisLimit: 0, total: 'sum' },
  disk_fs_size: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  disk_fs_used: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  disk_fs_used_system: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  pg_stat_database_num_backends: { format: '', yAxisLimit: 0, total: 'latest' },
  client_connections_postgres: { format: '', yAxisLimit: 0, total: 'latest' },
  client_connections_authenticator: { format: '', yAxisLimit: 0, total: 'latest' },
  client_connections_supabase_admin: { format: '', yAxisLimit: 0, total: 'latest' },
  client_connections_supabase_auth_admin: { format: '', yAxisLimit: 0, total: 'latest' },
  client_connections_supabase_storage_admin: { format: '', yAxisLimit: 0, total: 'latest' },
  client_connections_other: { format: '', yAxisLimit: 0, total: 'latest' },
  pg_database_size: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  disk_fs_used_wal: { format: 'bytes', yAxisLimit: 0, total: 'latest' },
  realtime_sum_connections_connected: { format: '', yAxisLimit: 0, total: 'latest' },
  realtime_connections_connected: { format: '', yAxisLimit: 0, total: 'latest' },
  supavisor_connections_active: { format: '', yAxisLimit: 0, total: 'latest' },
  // SERVICE_COUNTERS attributes (T1-pin table, fixture-present only — see
  // SERVICE_COUNTERS below for the exact source-series wiring).
  realtime_channel_joins: { format: '', yAxisLimit: 0, total: 'sum' },
  realtime_channel_events: { format: '', yAxisLimit: 0, total: 'sum' },
  realtime_channel_presence_events: { format: '', yAxisLimit: 0, total: 'sum' },
  realtime_channel_db_events: { format: '', yAxisLimit: 0, total: 'sum' },
  realtime_payload_size: { format: 'bytes-per-second', yAxisLimit: 0, total: 'sum' },
}

// Vector metric names. The committed T1 fixture is the binding source: the
// fixture-smoke test asserts every HOST name exists there — if it disagrees,
// update this constant to the fixture's name (fixture wins).
const HOST = {
  cpuSeconds: 'host_cpu_seconds_total',
  memTotal: 'host_memory_total_bytes',
  memFree: 'host_memory_free_bytes',
  memCached: 'host_memory_cached_bytes',
  memBuffers: 'host_memory_buffers_bytes',
  swapUsed: 'host_memory_swap_used_bytes',
  swapTotal: 'host_memory_swap_total_bytes',
  fsTotal: 'host_filesystem_total_bytes',
  fsUsed: 'host_filesystem_used_bytes',
  netRx: 'host_network_receive_bytes_total',
  netTx: 'host_network_transmit_bytes_total',
  diskReadBytes: 'host_disk_read_bytes_total',
  diskWrittenBytes: 'host_disk_written_bytes_total',
  diskReads: 'host_disk_reads_completed_total',
  diskWrites: 'host_disk_writes_completed_total',
} as const

// [self-platform] M6.4: cAdvisor container_* names (via vector on :9598). The
// container dialect (see computeContainerAttributes). Names are the binding
// fixture __fixtures__/cadvisor-scrape.prom — fixture wins over this comment.
const CONTAINER = {
  cpuUsage: 'container_cpu_usage_seconds_total',
  cpuUser: 'container_cpu_user_seconds_total',
  cpuSystem: 'container_cpu_system_seconds_total',
  memWorkingSet: 'container_memory_working_set_bytes',
  memCache: 'container_memory_cache',
  memSwap: 'container_memory_swap',
  specMemLimit: 'container_spec_memory_limit_bytes',
  specCpuQuota: 'container_spec_cpu_quota',
  specCpuPeriod: 'container_spec_cpu_period',
  netRx: 'container_network_receive_bytes_total',
  netTx: 'container_network_transmit_bytes_total',
} as const
const MACHINE = { cpuCores: 'machine_cpu_cores', memBytes: 'machine_memory_bytes' } as const

// Fixture-present service series only (T1 spike pins 2-3).
//
// T1-pin correction: the global gauge (`realtime_connections_global_connected`)
// live-proved 0 under real load while the per-tenant gauge
// (`realtime_connections_connected`) read 1 — so BOTH attributes source from
// `realtime_connections_connected`, never the global series.
const SERVICE_GAUGES: Array<{ source: string; attribute: string }> = [
  { source: 'realtime_connections_connected', attribute: 'realtime_sum_connections_connected' },
  { source: 'realtime_connections_connected', attribute: 'realtime_connections_connected' },
  { source: 'supavisor_connections_active', attribute: 'supavisor_connections_active' },
]
// T1's committed fixture has the four realtime channel counters as plain
// (non-`_global_`, tenant-scoped) series — wired 1:1. `realtime_payload_size`
// itself only exists in the fixture as a histogram (`_bucket`/`_sum`/`_count`,
// no bare series) — `_sum` is the monotonic cumulative byte total, so it's the
// rate-able source for the `realtime_payload_size` attribute (fixture wins:
// same substitution class as a HOST name correction, not an invention).
const SERVICE_COUNTERS: Array<{ source: string; attribute: string }> = [
  { source: 'realtime_channel_joins', attribute: 'realtime_channel_joins' },
  { source: 'realtime_channel_events', attribute: 'realtime_channel_events' },
  { source: 'realtime_channel_presence_events', attribute: 'realtime_channel_presence_events' },
  { source: 'realtime_channel_db_events', attribute: 'realtime_channel_db_events' },
  { source: 'realtime_payload_size_sum', attribute: 'realtime_payload_size' },
]

export interface PromSample {
  name: string
  labels: Record<string, string>
  value: number
}

const LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)(?:\s+\d+)?$/
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

export function parsePrometheusText(text: string): PromSample[] {
  const out: PromSample[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = LINE_RE.exec(line)
    if (m === null) continue
    const value = Number(m[3])
    if (!Number.isFinite(value)) continue // NaN/±Inf are unusable for charts
    const labels: Record<string, string> = {}
    if (m[2]) {
      for (const lm of m[2].matchAll(LABEL_RE)) {
        labels[lm[1]] = lm[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    }
    out.push({ name: m[1], labels, value })
  }
  return out
}

export interface Snapshot {
  at: number
  samples: PromSample[]
}
const lastScrape = new Map<string, Snapshot>()

type LabelPred = (labels: Record<string, string>) => boolean

// Shared by both dialects: percentages are clamped to [0, 100].
const clamp = (v: number) => Math.min(100, Math.max(0, v))

function sumSeries(samples: PromSample[], name: string, pred?: LabelPred): number | undefined {
  let total: number | undefined
  for (const s of samples) {
    if (s.name !== name) continue
    if (pred && !pred(s.labels)) continue
    total = (total ?? 0) + s.value
  }
  return total
}

function counterDelta(
  prev: Snapshot,
  curr: Snapshot,
  name: string,
  pred?: LabelPred
): number | undefined {
  const a = sumSeries(prev.samples, name, pred)
  const b = sumSeries(curr.samples, name, pred)
  if (a === undefined || b === undefined) return undefined
  const d = b - a
  return d < 0 ? undefined : d // counter reset → skip this cycle (designed gap)
}

// Vector's Linux cpu collector emits underscore-spelled mode labels
// (`io_wait`, `soft_irq`), not the no-underscore spellings some other
// exporters use. The committed T1 fixture proves `io_wait` directly
// (non-zero even at idle); it has no irq samples to cross-check, but
// `soft_irq` follows the same underscore convention vector uses for
// `io_wait` — so it's a same-class fixture-backed correction, not a guess.
const CPU_MODE_GROUPS: Record<string, string[]> = {
  cpu_usage_busy_system: ['system'],
  cpu_usage_busy_user: ['user', 'nice'],
  cpu_usage_busy_iowait: ['io_wait'],
  cpu_usage_busy_irqs: ['irq', 'soft_irq'],
}

// Host-level disk (filesystem size/used + disk-IO rates) — shared by the host
// and container dialects (disk is not container-meaningful; spec §5). Verbatim
// move of the fs + disk-rate blocks from computeScrapeAttributes.
function computeHostDisk(prev: Snapshot | undefined, curr: Snapshot): Record<string, number> {
  const out: Record<string, number> = {}
  const S = curr.samples

  // Filesystem: root mount, falling back to the largest filesystem.
  let mount = '/'
  if (sumSeries(S, HOST.fsTotal, (l) => l.mountpoint === mount) === undefined) {
    let bestVal = -1
    for (const s of S) {
      if (s.name === HOST.fsTotal && s.value > bestVal && s.labels.mountpoint !== undefined) {
        bestVal = s.value
        mount = s.labels.mountpoint
      }
    }
  }
  const onMount: LabelPred = (l) => l.mountpoint === mount
  const fsSize = sumSeries(S, HOST.fsTotal, onMount)
  const fsUsed = sumSeries(S, HOST.fsUsed, onMount)
  if (fsSize !== undefined) out.disk_fs_size = fsSize
  if (fsUsed !== undefined) out.disk_fs_used = fsUsed

  if (prev !== undefined) {
    const elapsed = (curr.at - prev.at) / 1000
    if (elapsed > 0) {
      const rate = (name: string, pred?: LabelPred): number | undefined => {
        const d = counterDelta(prev, curr, name, pred)
        return d === undefined ? undefined : d / elapsed
      }
      const pairs: Array<[string, number | undefined]> = [
        ['disk_bytes_read', rate(HOST.diskReadBytes)],
        ['disk_bytes_written', rate(HOST.diskWrittenBytes)],
        ['disk_iops_read', rate(HOST.diskReads)],
        ['disk_iops_write', rate(HOST.diskWrites)],
      ]
      for (const [attr, v] of pairs) if (v !== undefined) out[attr] = v
    }
  }
  return out
}

// realtime/supavisor gauges + channel counters — shared by both dialects.
// Verbatim move of the SERVICE_GAUGES + SERVICE_COUNTERS blocks.
function computeServiceAttributes(
  prev: Snapshot | undefined,
  curr: Snapshot
): Record<string, number> {
  const out: Record<string, number> = {}
  const S = curr.samples
  for (const { source, attribute } of SERVICE_GAUGES) {
    const v = sumSeries(S, source)
    if (v !== undefined) out[attribute] = v
  }
  if (prev !== undefined) {
    const elapsed = (curr.at - prev.at) / 1000
    if (elapsed > 0) {
      for (const { source, attribute } of SERVICE_COUNTERS) {
        const d = counterDelta(prev, curr, source)
        if (d !== undefined) out[attribute] = d / elapsed
      }
    }
  }
  return out
}

export function computeScrapeAttributes(
  prev: Snapshot | undefined,
  curr: Snapshot
): Record<string, number> {
  const out: Record<string, number> = {}
  const S = curr.samples

  const memTotal = sumSeries(S, HOST.memTotal)
  const memFree = sumSeries(S, HOST.memFree)
  const memCached = sumSeries(S, HOST.memCached) ?? 0
  const memBuffers = sumSeries(S, HOST.memBuffers) ?? 0
  if (memTotal !== undefined) out.ram_usage_total = memTotal
  if (memFree !== undefined) out.ram_usage_free = memFree
  if (memTotal !== undefined && memFree !== undefined) {
    out.ram_usage_cache_and_buffers = memCached + memBuffers
    const used = Math.max(0, memTotal - memFree - memCached - memBuffers)
    out.ram_usage_used = used
    if (memTotal > 0) out.ram_usage = clamp((used / memTotal) * 100)
  }
  const swapUsed = sumSeries(S, HOST.swapUsed)
  const swapTotal = sumSeries(S, HOST.swapTotal)
  if (swapUsed !== undefined) out.ram_usage_swap = swapUsed
  if (swapUsed !== undefined && swapTotal !== undefined && swapTotal > 0) {
    out.swap_usage = clamp((swapUsed / swapTotal) * 100)
  }

  // Shared, host-level (disk fs/IO + realtime/supavisor services).
  Object.assign(out, computeHostDisk(prev, curr))
  Object.assign(out, computeServiceAttributes(prev, curr))

  if (prev !== undefined) {
    const elapsed = (curr.at - prev.at) / 1000
    if (elapsed > 0) {
      const rate = (name: string, pred?: LabelPred): number | undefined => {
        const d = counterDelta(prev, curr, name, pred)
        return d === undefined ? undefined : d / elapsed
      }
      const notLo: LabelPred = (l) => l.device !== 'lo'
      const pairs: Array<[string, number | undefined]> = [
        ['network_receive_bytes', rate(HOST.netRx, notLo)],
        ['network_transmit_bytes', rate(HOST.netTx, notLo)],
      ]
      for (const [attr, v] of pairs) if (v !== undefined) out[attr] = v

      const totalCpu = counterDelta(prev, curr, HOST.cpuSeconds)
      if (totalCpu !== undefined && totalCpu > 0) {
        const modePct = (modes: string[]): number | undefined => {
          const d = counterDelta(prev, curr, HOST.cpuSeconds, (l) => modes.includes(l.mode))
          return d === undefined ? undefined : clamp((d / totalCpu) * 100)
        }
        let accounted = 0
        for (const [attr, modes] of Object.entries(CPU_MODE_GROUPS)) {
          const p = modePct(modes)
          if (p !== undefined) {
            out[attr] = p
            accounted += p
          }
        }
        const idle = modePct(['idle'])
        if (idle !== undefined) {
          const busy = clamp(100 - idle)
          out.avg_cpu_usage = busy
          // Single-host sample grain: no per-node spread to take a max over
          // (spec §12) — same value, honestly.
          out.max_cpu_usage = busy
          out.cpu_usage_busy_other = clamp(busy - accounted)
        }
      }
    }
  }
  return out
}

export interface ContainerSelector {
  cpuMem: LabelPred // selects the workload container's cpu/mem/spec series
  net: LabelPred // selects the network series (already excludes lo)
  cpuDenom: LabelPred // selects the container's spec cpu quota/period series
}

// Compose dialect: cAdvisor tags the Postgres container by its friendly `name`.
export function composeSelector(containerName: string): ContainerSelector {
  const mine: LabelPred = (l) => l.name === containerName
  return {
    cpuMem: mine,
    cpuDenom: mine,
    net: (l) => l.name === containerName && l.interface !== 'lo',
  }
}

export function computeContainerAttributes(
  prev: Snapshot | undefined,
  curr: Snapshot,
  selector: ContainerSelector
): Record<string, number> {
  const out: Record<string, number> = {}
  const S = curr.samples
  const mine = selector.cpuMem

  // --- Memory (absolute + % vs limit-or-machine) ---
  const used = sumSeries(S, CONTAINER.memWorkingSet, mine)
  if (used !== undefined) {
    out.ram_usage_used = used
    const machineMem = sumSeries(S, MACHINE.memBytes)
    const limit = sumSeries(S, CONTAINER.specMemLimit, mine)
    // cAdvisor reports limit=0 (or >= machine) when unlimited → fall back to machine.
    const total =
      limit !== undefined && limit > 0 && (machineMem === undefined || limit < machineMem)
        ? limit
        : machineMem
    if (total !== undefined && total > 0) {
      out.ram_usage_total = total
      out.ram_usage = clamp((used / total) * 100)
      // NOTE: "free" here is machine-relative in container mode — total is the
      // machine memory (or the container limit when set), so ram_usage_free is
      // the machine/limit headroom, NOT the container's own free memory (a
      // container has no fixed size without a limit). Consistent with R1's
      // machine-as-denominator model (used + free = total).
      out.ram_usage_free = Math.max(0, total - used)
    }
    const cache = sumSeries(S, CONTAINER.memCache, mine)
    if (cache !== undefined) out.ram_usage_cache_and_buffers = cache
    const swap = sumSeries(S, CONTAINER.memSwap, mine)
    if (swap !== undefined) out.ram_usage_swap = swap
  }

  // --- Shared, host-level (disk fs/IO + realtime/supavisor services) ---
  Object.assign(out, computeHostDisk(prev, curr))
  Object.assign(out, computeServiceAttributes(prev, curr))

  if (prev === undefined) return out
  const elapsed = (curr.at - prev.at) / 1000
  if (elapsed <= 0) return out

  // --- CPU (% of machine cores, or of the cpu quota when set) ---
  const cores = cpuDenominatorCores(S, selector.cpuDenom)
  const totalDelta = counterDelta(prev, curr, CONTAINER.cpuUsage, mine)
  if (cores !== undefined && cores > 0 && totalDelta !== undefined && totalDelta >= 0) {
    const pct = clamp((totalDelta / elapsed / cores) * 100)
    out.avg_cpu_usage = pct
    out.max_cpu_usage = pct // single-container grain: no spread to max over
    let accounted = 0
    const userDelta = counterDelta(prev, curr, CONTAINER.cpuUser, mine)
    if (userDelta !== undefined) {
      out.cpu_usage_busy_user = clamp((userDelta / elapsed / cores) * 100)
      accounted += out.cpu_usage_busy_user
    }
    const sysDelta = counterDelta(prev, curr, CONTAINER.cpuSystem, mine)
    if (sysDelta !== undefined) {
      out.cpu_usage_busy_system = clamp((sysDelta / elapsed / cores) * 100)
      accounted += out.cpu_usage_busy_system
    }
    out.cpu_usage_busy_other = clamp(pct - accounted)
    // iowait/irqs intentionally omitted — cgroup cpu.stat has no such modes.
  }

  // --- Network (per-container rate, excluding loopback) ---
  const netRx = counterDelta(prev, curr, CONTAINER.netRx, selector.net)
  if (netRx !== undefined) out.network_receive_bytes = netRx / elapsed
  const netTx = counterDelta(prev, curr, CONTAINER.netTx, selector.net)
  if (netTx !== undefined) out.network_transmit_bytes = netTx / elapsed

  return out
}

// Prefer an explicit cpu quota (quota/period cores) when the operator set one;
// else the machine's core count (docker-stats semantics, spec R1).
function cpuDenominatorCores(S: PromSample[], mine: LabelPred): number | undefined {
  const quota = sumSeries(S, CONTAINER.specCpuQuota, mine)
  const period = sumSeries(S, CONTAINER.specCpuPeriod, mine)
  if (quota !== undefined && quota > 0 && period !== undefined && period > 0) return quota / period
  return sumSeries(S, MACHINE.cpuCores)
}

const L1_MAIN_SQL = `
select
  (select count(*)::float8 from pg_stat_activity where datname = current_database()) as pg_stat_database_num_backends,
  (select count(*)::float8 from pg_stat_activity where datname = current_database() and usename = 'postgres') as client_connections_postgres,
  (select count(*)::float8 from pg_stat_activity where datname = current_database() and usename = 'authenticator') as client_connections_authenticator,
  (select count(*)::float8 from pg_stat_activity where datname = current_database() and usename = 'supabase_admin') as client_connections_supabase_admin,
  (select count(*)::float8 from pg_stat_activity where datname = current_database() and usename = 'supabase_auth_admin') as client_connections_supabase_auth_admin,
  (select count(*)::float8 from pg_stat_activity where datname = current_database() and usename = 'supabase_storage_admin') as client_connections_supabase_storage_admin,
  (select count(*)::float8 from pg_stat_activity where datname = current_database()
     and (usename is null or usename not in ('postgres','authenticator','supabase_admin','supabase_auth_admin','supabase_storage_admin'))) as client_connections_other,
  pg_database_size(current_database())::float8 as pg_database_size`

const L1_WAL_SQL = `select coalesce(sum(size), 0)::float8 as disk_fs_used_wal from pg_ls_waldir()`

async function executeProjectQuery(
  pgConnEncrypted: string,
  query: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`${PG_META_URL}/query`, {
    method: 'POST',
    headers: constructHeaders({
      'Content-Type': 'application/json',
      'x-connection-encrypted': pgConnEncrypted,
    }),
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(METRICS_L1_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`pg-meta HTTP ${response.status}`)
  const rows = (await response.json()) as Record<string, unknown>[]
  return rows[0] ?? {}
}

function warn(ref: string, stage: string, err: unknown): void {
  console.warn(
    `[self-platform] metrics ${stage} failed for "${ref}": ${err instanceof Error ? err.message : String(err)}`
  )
}

export async function sampleProject(ref: string): Promise<void> {
  const conn = await resolveProjectConnection(ref)
  const values: Record<string, number> = {}
  const collect = (row: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(row)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n) && k in ATTRIBUTE_META) values[k] = n
    }
  }
  // L1 — statement-isolated: a failing statement (e.g. pg_ls_waldir privilege
  // on a locked-down external stack) drops only its own attributes.
  try {
    collect(await executeProjectQuery(conn.pgConnEncrypted, L1_MAIN_SQL))
  } catch (err) {
    warn(ref, 'L1 connections/size', err)
  }
  try {
    collect(await executeProjectQuery(conn.pgConnEncrypted, L1_WAL_SQL))
  } catch (err) {
    warn(ref, 'L1 wal', err)
  }
  if (conn.metricsUrl) {
    try {
      const headers: Record<string, string> = {}
      if (conn.metricsToken) headers.Authorization = `Bearer ${conn.metricsToken}`
      const resp = await fetch(conn.metricsUrl, {
        headers,
        signal: AbortSignal.timeout(METRICS_SCRAPE_TIMEOUT_MS),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const curr: Snapshot = { at: Date.now(), samples: parsePrometheusText(await resp.text()) }
      // Container dialect when the row is pinned to a container (Task 2), else
      // the host-level dialect (M6.3 behavior). Both emit ATTRIBUTE_META keys.
      const sel =
        conn.containerName != null && conn.containerName !== ''
          ? composeSelector(conn.containerName)
          : null
      const scraped = sel
        ? computeContainerAttributes(lastScrape.get(ref), curr, sel)
        : computeScrapeAttributes(lastScrape.get(ref), curr)
      Object.assign(values, scraped)
      lastScrape.set(ref, curr)
    } catch (err) {
      warn(ref, 'L2 scrape', err)
    }
  }
  // Derived last: stacked disk chart components stay self-consistent (spec §5).
  if (
    values.disk_fs_used !== undefined &&
    values.pg_database_size !== undefined &&
    values.disk_fs_used_wal !== undefined
  ) {
    values.disk_fs_used_system = Math.max(
      0,
      values.disk_fs_used - values.pg_database_size - values.disk_fs_used_wal
    )
  }
  const attrs = Object.keys(values)
  if (attrs.length === 0) return
  // Values fully parameterized; attribute names only ever come from
  // ATTRIBUTE_META keys (collect() filter) — M5.0 injection-barrier class.
  const params: unknown[] = [ref]
  const rows = attrs.map((a) => {
    params.push(a, values[a])
    return `($1, now(), $${params.length - 1}, $${params.length})`
  })
  const { error } = await executePlatformQuery({
    query: `insert into platform.metrics_samples (project_ref, sampled_at, attribute, value) values ${rows.join(', ')}`,
    parameters: params,
  })
  if (error) warn(ref, 'sample insert', error)
}

let lastSweepAt = 0
export async function sweepIfDue(now = Date.now()): Promise<void> {
  // lastSweepAt === 0 is the "never swept this process lifetime" sentinel —
  // the very first sweep must not be rate-limited against it (only actual
  // prior sweeps count towards SWEEP_MIN_INTERVAL_MS).
  if (lastSweepAt !== 0 && now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return
  lastSweepAt = now
  // Retention literal is our own numeric constant, never user input.
  const { error } = await executePlatformQuery({
    query: `delete from platform.metrics_samples where sampled_at < now() - interval '${METRICS_RETENTION_DAYS} days'`,
  })
  if (error) console.warn(`[self-platform] metrics sweep failed: ${error.message}`)
}

let cycleRunning = false
export async function runSamplerCycle(): Promise<void> {
  if (cycleRunning) return // an overrunning cycle skips ticks, never stacks
  cycleRunning = true
  try {
    // Status-independent on purpose: gating on `status` would stop sampling a
    // row the probe engine marked UNHEALTHY and never resume unprompted.
    const { data, error } = await executePlatformQuery<{ ref: string }>({
      query: 'select ref from platform.projects order by ref',
    })
    if (error) {
      console.warn(`[self-platform] metrics cycle: listing projects failed: ${error.message}`)
      return
    }
    await Promise.all(
      (data ?? []).map((row) => sampleProject(row.ref).catch((err) => warn(row.ref, 'sample', err)))
    )
    await sweepIfDue()
  } catch (err) {
    console.warn(
      `[self-platform] metrics cycle failed: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    cycleRunning = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
export function startMetricsSampler(): void {
  if (timer !== undefined) return
  timer = setInterval(() => {
    void runSamplerCycle()
  }, METRICS_SAMPLE_INTERVAL_MS)
  timer.unref?.()
  void runSamplerCycle()
}

export function resetMetricsSamplerForTest(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  cycleRunning = false
  lastSweepAt = 0
  lastScrape.clear()
}
