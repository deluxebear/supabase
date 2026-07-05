import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './health'
import { probeStackHealth, writeThroughStatus } from '@/lib/api/self-platform/health'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/health', () => ({
  probeStackHealth: vi.fn(),
  writeThroughStatus: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const RESULTS = [
  { name: 'db', status: 'ACTIVE_HEALTHY', healthy: true },
  { name: 'auth', status: 'ACTIVE_HEALTHY', healthy: true, info: { name: 'GoTrue' } },
  { name: 'rest', status: 'ACTIVE_HEALTHY', healthy: true },
  { name: 'storage', status: 'UNHEALTHY', healthy: false, error: 'HTTP 503' },
  { name: 'realtime', status: 'DISABLED', healthy: false },
] as never[]

const get = (query: Record<string, unknown>) => createMocks({ method: 'GET', query })

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(probeStackHealth)
    .mockReset()
    .mockResolvedValue({ results: RESULTS, fresh: true } as never)
  vi.mocked(writeThroughStatus).mockReset().mockResolvedValue(undefined)
})

describe('GET /v1/projects/[ref]/health (self-platform)', () => {
  it('probes, filters to requested services, maps the contract shape, writes through when fresh', async () => {
    const { req, res } = get({ ref: 'proj-x', services: 'auth,storage,realtime' })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'read:Read',
      projectRef: 'proj-x',
      resource: 'projects',
    })
    expect(probeStackHealth).toHaveBeenCalledWith('proj-x')
    expect(writeThroughStatus).toHaveBeenCalledWith('proj-x', RESULTS)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([
      { name: 'auth', healthy: true, status: 'ACTIVE_HEALTHY', info: { name: 'GoTrue' } },
      { name: 'storage', healthy: false, status: 'UNHEALTHY', error: 'HTTP 503' },
      { name: 'realtime', healthy: false, status: 'DISABLED' },
    ])
  })

  it('cache hit (fresh=false) skips write-through', async () => {
    vi.mocked(probeStackHealth).mockResolvedValue({ results: RESULTS, fresh: false } as never)
    const { req, res } = get({ ref: 'proj-x', services: 'db' })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(writeThroughStatus).not.toHaveBeenCalled()
    expect(res._getJSONData()).toEqual([{ name: 'db', healthy: true, status: 'ACTIVE_HEALTHY' }])
  })

  it('guard denial short-circuits before probing', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const { req, res } = get({ ref: 'proj-x', services: 'db' })
    await handler(req as never, res as never, claimsOf('g-0'))
    expect(probeStackHealth).not.toHaveBeenCalled()
  })

  it('array ref → 400 before the guard', async () => {
    const { req, res } = get({ ref: ['a', 'b'], services: 'db' })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })

  it('unknown requested service names are filtered out, not errored', async () => {
    const { req, res } = get({ ref: 'proj-x', services: 'db,pooler' })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getJSONData()).toEqual([{ name: 'db', healthy: true, status: 'ACTIVE_HEALTHY' }])
  })

  it('edge_function passes the services filter in self-platform mode (M6.2)', async () => {
    vi.mocked(probeStackHealth)
      .mockReset()
      .mockResolvedValue({
        results: [...RESULTS, { name: 'edge_function', status: 'ACTIVE_HEALTHY', healthy: true }],
        fresh: false,
      } as never)
    const { req, res } = get({ ref: 'proj-x', services: 'db,edge_function' })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getJSONData()).toEqual([
      { name: 'db', healthy: true, status: 'ACTIVE_HEALTHY' },
      { name: 'edge_function', healthy: true, status: 'ACTIVE_HEALTHY' },
    ])
  })
})
