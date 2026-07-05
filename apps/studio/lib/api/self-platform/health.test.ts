import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  CACHE_TTL_MS,
  clearHealthCache,
  probeStackHealth,
  writeThroughStatus,
  type ServiceProbeResult,
} from './health'
import { resolveProjectConnection } from './resolve-connection'

vi.mock('./resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('@/lib/api/apiHelpers', () => ({
  constructHeaders: vi.fn((h: Record<string, string>) => h),
}))

// [T1 tsc fix] hoisted so it's readable with a real type — `CONN` below is
// deliberately cast `as never` (partial ResolvedConnection stub), and TS
// does not allow property reads off a `never`-typed value.
const CONN_SUPABASE_URL = 'http://stack.example:8000'
const CONN = {
  ref: 'proj-x',
  supabaseUrl: CONN_SUPABASE_URL,
  anonKey: 'anon-key-x',
  pgConnEncrypted: 'enc-dsn',
} as never

const okResponse = (body: unknown = []) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
})
const errResponse = (status: number, body: unknown) => ({
  ok: false,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
})

beforeEach(() => {
  clearHealthCache()
  vi.mocked(resolveProjectConnection).mockReset().mockResolvedValue(CONN)
  vi.mocked(executePlatformQuery).mockReset().mockResolvedValue({ data: [], error: undefined })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ name: 'GoTrue', version: 'x' })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('probeStackHealth mapping', () => {
  it('all healthy → five ACTIVE_HEALTHY results, auth carries info', async () => {
    const { results, fresh } = await probeStackHealth('proj-x')
    expect(fresh).toBe(true)
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.status === 'ACTIVE_HEALTHY' && r.healthy)).toBe(true)
    const auth = results.find((r) => r.name === 'auth')!
    expect(auth.info).toMatchObject({ name: 'GoTrue' })
    // headers carry the anon key on HTTP probes
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([u]) => String(u).startsWith(CONN_SUPABASE_URL))
    expect(calls).toHaveLength(4)
    for (const [, init] of calls) {
      expect((init as RequestInit).headers).toMatchObject({
        apikey: 'anon-key-x',
        Authorization: 'Bearer anon-key-x',
      })
    }
  })

  it('kong no-route 404 → DISABLED (service not deployed)', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/storage/')
        ? (errResponse(404, { message: 'no Route matched with those values' }) as never)
        : (okResponse() as never)
    )
    const { results } = await probeStackHealth('proj-x')
    const storage = results.find((r) => r.name === 'storage')!
    expect(storage.status).toBe('DISABLED')
    expect(storage.error).toBeUndefined()
  })

  it('5xx → UNHEALTHY with HTTP code + message; other services unaffected', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/rest/')
        ? (errResponse(503, { message: 'upstream down' }) as never)
        : (okResponse() as never)
    )
    const { results } = await probeStackHealth('proj-x')
    const rest = results.find((r) => r.name === 'rest')!
    expect(rest.status).toBe('UNHEALTHY')
    expect(rest.error).toMatch(/HTTP 503/)
    expect(rest.error).toMatch(/upstream down/)
    expect(results.filter((r) => r.status === 'ACTIVE_HEALTHY')).toHaveLength(4)
  })

  // Realtime is a LIVENESS probe via the websocket route: the readiness API is
  // not gateway-exposed on stock self-hosted Kong, so ANY HTTP response (even
  // 403) proves the service is reachable behind the gateway; only 5xx/timeout/
  // network mean down (controller adjudication, live stop/start-verified).
  it('realtime 403 (websocket route, service up) → ACTIVE_HEALTHY, no info', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/realtime/')
        ? (errResponse(403, { message: 'forbidden' }) as never)
        : (okResponse() as never)
    )
    const { results } = await probeStackHealth('proj-x')
    const realtime = results.find((r) => r.name === 'realtime')!
    expect(realtime.status).toBe('ACTIVE_HEALTHY')
    expect(realtime.healthy).toBe(true)
    expect(realtime.error).toBeUndefined()
    expect(realtime.info).toBeUndefined()
  })

  it('realtime 503 (gateway up, service down) → UNHEALTHY with HTTP code', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/realtime/')
        ? (errResponse(503, { message: 'upstream down' }) as never)
        : (okResponse() as never)
    )
    const { results } = await probeStackHealth('proj-x')
    const realtime = results.find((r) => r.name === 'realtime')!
    expect(realtime.status).toBe('UNHEALTHY')
    expect(realtime.error).toMatch(/HTTP 503/)
    expect(results.filter((r) => r.status === 'ACTIVE_HEALTHY')).toHaveLength(4)
  })

  it('realtime network error → UNHEALTHY with the message', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes('/realtime/')) throw new Error('connect ECONNREFUSED 10.0.0.9:8000')
      return okResponse() as never
    })
    const { results } = await probeStackHealth('proj-x')
    const realtime = results.find((r) => r.name === 'realtime')!
    expect(realtime.status).toBe('UNHEALTHY')
    expect(realtime.error).toMatch(/ECONNREFUSED/)
  })

  it('network error → UNHEALTHY with the message, no credentials in error', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes('/auth/')) throw new Error('connect ECONNREFUSED 10.0.0.9:8000')
      return okResponse() as never
    })
    const { results } = await probeStackHealth('proj-x')
    const auth = results.find((r) => r.name === 'auth')!
    expect(auth.status).toBe('UNHEALTHY')
    expect(auth.error).toMatch(/ECONNREFUSED/)
    expect(JSON.stringify(results)).not.toContain('anon-key-x')
    expect(JSON.stringify(results)).not.toContain('enc-dsn')
  })

  it('db probe goes through the encrypted-DSN pg-meta channel', async () => {
    await probeStackHealth('proj-x')
    const dbCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/query'))!
    expect((dbCall[1] as RequestInit).headers).toMatchObject({
      'x-connection-encrypted': 'enc-dsn',
    })
    expect((dbCall[1] as RequestInit).body).toBe(JSON.stringify({ query: 'select 1' }))
  })
})

describe('cache TTL', () => {
  it('second call within TTL is served from cache (fresh=false, no new fetch/resolve)', async () => {
    await probeStackHealth('proj-x')
    const fetches = vi.mocked(fetch).mock.calls.length
    const second = await probeStackHealth('proj-x')
    expect(second.fresh).toBe(false)
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetches)
    expect(resolveProjectConnection).toHaveBeenCalledTimes(1)
  })

  it('re-probes after TTL expiry', async () => {
    const t0 = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    await probeStackHealth('proj-x')
    nowSpy.mockReturnValue(t0 + CACHE_TTL_MS + 1)
    const { fresh } = await probeStackHealth('proj-x')
    expect(fresh).toBe(true)
    expect(resolveProjectConnection).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })
})

describe('writeThroughStatus', () => {
  const resultsWithDb = (status: 'ACTIVE_HEALTHY' | 'UNHEALTHY'): ServiceProbeResult[] => [
    { name: 'db', status, healthy: status === 'ACTIVE_HEALTHY' },
    { name: 'storage', status: 'UNHEALTHY', healthy: false, error: 'x' },
  ]

  it('writes db-derived status with the guarded single-statement UPDATE', async () => {
    await writeThroughStatus('proj-x', resultsWithDb('UNHEALTHY'))
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual(['proj-x', 'UNHEALTHY'])
    expect(call.query).toContain('status is distinct from $2')
    expect(call.query).toContain("interval '60 seconds'")
    expect(call.query).toContain('last_health_at = now()')
  })

  it('aux-service failure does NOT flip status when db is healthy (spec D3)', async () => {
    await writeThroughStatus('proj-x', resultsWithDb('ACTIVE_HEALTHY'))
    expect(vi.mocked(executePlatformQuery).mock.calls.at(-1)![0].parameters).toEqual([
      'proj-x',
      'ACTIVE_HEALTHY',
    ])
  })

  it('write failure warns and does not throw', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('platform-db gone'),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      writeThroughStatus('proj-x', resultsWithDb('ACTIVE_HEALTHY'))
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/write-through failed/)
    warn.mockRestore()
  })

  it('transport-level rejection warns and does not throw (spec §8)', async () => {
    vi.mocked(executePlatformQuery).mockRejectedValue(new Error('fetch failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      writeThroughStatus('proj-x', resultsWithDb('ACTIVE_HEALTHY'))
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/write-through failed/)
    warn.mockRestore()
  })
})
