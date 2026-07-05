// [self-platform] M6.0: real per-stack health probing (spec §3). On-demand,
// short module-level cache, results written back to the registry by
// writeThroughStatus (spec §4). Zero stack-side agents — everything is
// probed from the Studio server using the registry's connection material.
// Spec: docs/self-hosted-parity/2026-07-05-M6.0-health-probing-design.md
import { executePlatformQuery } from './db'
import { resolveProjectConnection } from './resolve-connection'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { PG_META_URL } from '@/lib/constants'

export type ProbeService = 'db' | 'auth' | 'rest' | 'storage' | 'realtime'
export type ProbeStatus = 'ACTIVE_HEALTHY' | 'UNHEALTHY' | 'DISABLED'

export interface ServiceProbeResult {
  name: ProbeService
  status: ProbeStatus
  healthy: boolean
  error?: string
  info?: unknown
}

export const PROBE_TIMEOUT_MS = 5_000
export const CACHE_TTL_MS = 20_000

// Health paths pinned by the T1 live spike (keep in sync with README M6.0).
// SPIKE NOTE (2026-07-05, against supabase/realtime:v2.102.3 behind the
// standard docker/volumes/api/kong.yml): neither candidate 200s — both
// /realtime/v1/api/health and /realtime/v1/health return a bare 404 "Not
// Found" from the realtime container itself (not a Kong no-route body). The
// service's actual working health endpoint (/api/tenants/<tenant>/health,
// verified 200 with a real health payload when hit directly on the
// container) is deliberately blocked at the gateway by the
// "realtime-v1-rest-tenants" route (403 "Access is forbidden") — unrelated
// to M6.0, pre-existing kong.yml hardening. Net effect: realtime probes
// degrade to UNHEALTHY ("HTTP 404") honestly on this stack version/gateway
// pairing rather than reporting fake-green (spec §10 risk 1/5 accepted
// degradation). Kept the spec's primary candidate pending a gateway-side
// fix (tracked as a T1 concern, not a T1 blocker — see task-1-report.md).
export const SERVICE_HEALTH_PATHS: Record<Exclude<ProbeService, 'db'>, string> = {
  auth: '/auth/v1/health',
  rest: '/rest/v1/',
  storage: '/storage/v1/status',
  realtime: '/realtime/v1/api/health',
}

// Kong's no-route body marker → the service is not deployed behind this
// gateway: DISABLED, not UNHEALTHY (spec §3 mapping). Pinned by the spike.
// SPIKE NOTE: on the live stack, Kong's `dashboard` route (paths: ["/"],
// docker/volumes/api/kong.yml) is a catch-all matched by every otherwise-
// unmapped path, so a genuine unmatched request never reaches Kong's
// router-level "no Route matched" 404 — it hits the dashboard route's
// basic-auth plugin and gets a 401 "Unauthorized" JSON body instead. The
// 404-scoped check below therefore can't fire against THIS gateway config;
// it remains meaningful for attached stacks with a minimal/no-catch-all
// Kong config (§10 risk 2, accepted). Kept the spec's default marker text
// unchanged since no genuine no-route 404 was observable to re-pin it from.
const KONG_NO_ROUTE_MARKER = 'no Route matched'

interface CacheEntry {
  at: number
  results: ServiceProbeResult[]
}
const cache = new Map<string, CacheEntry>()

export function clearHealthCache(): void {
  cache.clear()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function probeHttp(
  name: Exclude<ProbeService, 'db'>,
  url: string,
  anonKey: string
): Promise<ServiceProbeResult> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const text = await response.text()
    if (response.ok) {
      let info: unknown
      try {
        info = JSON.parse(text)
      } catch {
        // healthy non-JSON body (e.g. PostgREST root HTML/openapi) — no info
      }
      return {
        name,
        status: 'ACTIVE_HEALTHY',
        healthy: true,
        // info is only contract-meaningful for auth (GoTrue health payload)
        ...(name === 'auth' && info !== undefined ? { info } : {}),
      }
    }
    if (response.status === 404 && text.includes(KONG_NO_ROUTE_MARKER)) {
      return { name, status: 'DISABLED', healthy: false }
    }
    let message = `HTTP ${response.status}`
    try {
      const body = JSON.parse(text)
      if (typeof body?.message === 'string') message = `${message}: ${body.message}`
    } catch {
      // non-JSON error body — keep the bare HTTP code
    }
    return { name, status: 'UNHEALTHY', healthy: false, error: message }
  } catch (err) {
    return { name, status: 'UNHEALTHY', healthy: false, error: errorMessage(err) }
  }
}

async function probeDb(pgConnEncrypted: string): Promise<ServiceProbeResult> {
  try {
    const response = await fetch(`${PG_META_URL}/query`, {
      method: 'POST',
      headers: constructHeaders({
        'Content-Type': 'application/json',
        'x-connection-encrypted': pgConnEncrypted,
      }),
      body: JSON.stringify({ query: 'select 1' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.ok) return { name: 'db', status: 'ACTIVE_HEALTHY', healthy: true }
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { message?: unknown }
      if (typeof body?.message === 'string') message = body.message
    } catch {
      // non-JSON error body
    }
    return { name: 'db', status: 'UNHEALTHY', healthy: false, error: message }
  } catch (err) {
    return { name: 'db', status: 'UNHEALTHY', healthy: false, error: errorMessage(err) }
  }
}

/**
 * Probe all five services of a registered stack. `fresh` is true when this
 * call actually probed (cache miss) — callers write through only then.
 * Ghost refs throw ProjectNotFound (apiWrapper maps to 404).
 */
export async function probeStackHealth(
  ref: string
): Promise<{ results: ServiceProbeResult[]; fresh: boolean }> {
  const now = Date.now()
  const hit = cache.get(ref)
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { results: hit.results, fresh: false }
  }
  const conn = await resolveProjectConnection(ref)
  const base = conn.supabaseUrl.replace(/\/$/, '')
  const httpServices = ['auth', 'rest', 'storage', 'realtime'] as const
  const results = await Promise.all([
    probeDb(conn.pgConnEncrypted),
    ...httpServices.map((name) =>
      probeHttp(name, `${base}${SERVICE_HEALTH_PATHS[name]}`, conn.anonKey)
    ),
  ])
  cache.set(ref, { at: now, results })
  return { results, fresh: true }
}

/**
 * Write the observed status back to the registry (spec §4). Project status
 * reflects the db probe only (spec D3). Single guarded UPDATE bounds write
 * volume: only when the status changed or the last write is >60s old.
 * Persistence failures are logged, never thrown — observation ≠ persistence.
 */
export async function writeThroughStatus(
  ref: string,
  results: ServiceProbeResult[]
): Promise<void> {
  const db = results.find((r) => r.name === 'db')
  if (!db) return
  const status = db.status === 'ACTIVE_HEALTHY' ? 'ACTIVE_HEALTHY' : 'UNHEALTHY'
  const { error } = await executePlatformQuery({
    query: `update platform.projects
      set status = $2, last_health_at = now()
      where ref = $1
        and (status is distinct from $2
             or last_health_at is null
             or last_health_at < now() - interval '60 seconds')`,
    parameters: [ref, status],
  })
  if (error) {
    console.warn(`[self-platform] health write-through failed for "${ref}": ${error.message}`)
  }
}
