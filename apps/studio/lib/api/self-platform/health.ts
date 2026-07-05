// [self-platform] M6.0: real per-stack health probing (spec §3). On-demand,
// short module-level cache, results written back to the registry by
// writeThroughStatus (spec §4). Zero stack-side agents — everything is
// probed from the Studio server using the registry's connection material.
// Spec: docs/self-hosted-parity/2026-07-05-M6.0-health-probing-design.md
import { executePlatformQuery } from './db'
import { resolveProjectConnection } from './resolve-connection'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { PG_META_URL } from '@/lib/constants'

export type ProbeService = 'db' | 'auth' | 'rest' | 'storage' | 'realtime' | 'edge_function'
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
// standard docker/volumes/api/kong.yml): realtime's readiness API is NOT
// gateway-exposed on stock self-hosted Kong — both spec candidates
// (/realtime/v1/api/health, /realtime/v1/health) 404 from the container
// itself, and the working tenant endpoint (/api/tenants/<tenant>/health) is
// Kong-blocked with a constant 403 regardless of whether the service is up
// (controller-verified via a live stop/start cycle — zero signal). The
// websocket route DOES discriminate: 403 when realtime is UP, 503 when
// DOWN. So realtime is a LIVENESS check via the websocket route — any HTTP
// response (even 403) proves the service is reachable behind the gateway;
// only 5xx/timeout/network mean down (see the realtime override in
// probeHttp).
export const SERVICE_HEALTH_PATHS: Record<Exclude<ProbeService, 'db'>, string> = {
  auth: '/auth/v1/health',
  rest: '/rest/v1/',
  storage: '/storage/v1/status',
  realtime: '/realtime/v1/websocket',
  // M6.2 SPIKE NOTE (2026-07-06, edge-runtime v1.74.0 behind stock kong.yml):
  // the BARE path is the only safe probe — the main worker answers 400
  // "missing function name in request" (executed Deno code = liveness+ proof);
  // any NAMED path spawns a worker for that function and 500s when it does
  // not exist. VERIFY_JWT=true stacks answer 401 without a key, 400 with a
  // valid anon key — all sub-5xx, all liveness proof.
  edge_function: '/functions/v1/',
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

// [self-platform] M6.1: optional per-ref invalidation — a connection-config
// PATCH must not leave 20s of the OLD stack's probe results on screen
// (spec D4). No-arg keeps the clear-all semantics (test/bootstrap callers).
export function clearHealthCache(ref?: string): void {
  if (ref === undefined) {
    cache.clear()
  } else {
    cache.delete(ref)
  }
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
    // Liveness services: any sub-5xx response proves the service is reachable
    // and executing behind the gateway. realtime: M6.0 ratified semantics
    // unchanged (no body read at all on the fast path — M6.0 deferred minor).
    // edge_function additionally honors the Kong no-route marker FIRST
    // (spec D4): a 404 whose body says the gateway has no such route means
    // "not deployed" → DISABLED, not fake-alive.
    if (name === 'realtime' && response.status < 500) {
      return { name, status: 'ACTIVE_HEALTHY', healthy: true }
    }
    if (name === 'edge_function' && response.status < 500) {
      if (response.status === 404) {
        const body = await response.text()
        if (body.includes(KONG_NO_ROUTE_MARKER)) {
          return { name, status: 'DISABLED', healthy: false }
        }
      }
      return { name, status: 'ACTIVE_HEALTHY', healthy: true }
    }
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
 * Probe all six services of a registered stack. `fresh` is true when this
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
  const httpServices = ['auth', 'rest', 'storage', 'realtime', 'edge_function'] as const
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
  try {
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
  } catch (err) {
    console.warn(
      `[self-platform] health write-through failed for "${ref}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
