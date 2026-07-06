import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './infra-monitoring'
import { executePlatformQuery } from '@/lib/api/self-platform/db'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const CLAIMS = { sub: 'g-1' } as never

const run = async (query: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'GET', query })
  await handler(req as never, res as never, CLAIMS)
  return res
}

const BASE_QUERY = {
  ref: 'proj-x',
  attributes: 'avg_cpu_usage,ram_usage',
  startDate: '2026-07-06T00:00:00.000Z',
  endDate: '2026-07-06T01:00:00.000Z',
  interval: '1m',
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(executePlatformQuery).mockReset().mockResolvedValue({ data: [], error: undefined })
})

describe('GET infra-monitoring (self-platform)', () => {
  it('405s non-GET with Allow', async () => {
    const { req, res } = createMocks({ method: 'POST', query: BASE_QUERY })
    await handler(req as never, res as never, CLAIMS)
    expect(res._getStatusCode()).toBe(405)
    expect(res._getHeaders().allow).toEqual(['GET'])
  })
  it('400s param problems BEFORE the guard (order pinned)', async () => {
    for (const bad of [
      { ...BASE_QUERY, ref: ['a', 'b'] },
      { ...BASE_QUERY, attributes: undefined },
      { ...BASE_QUERY, attributes: '' },
      { ...BASE_QUERY, interval: '2m' },
      { ...BASE_QUERY, startDate: undefined },
      { ...BASE_QUERY, startDate: 'not-a-date' },
    ]) {
      vi.mocked(guardProjectRoute).mockClear()
      const res = await run(bad as never)
      expect(res._getStatusCode()).toBe(400)
      expect(vi.mocked(guardProjectRoute)).not.toHaveBeenCalled()
    }
  })
  it('guard deny → handler returns without touching the samples table', async () => {
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const res = await run(BASE_QUERY)
    expect(res._getStatusCode()).toBe(403)
    expect(vi.mocked(executePlatformQuery)).not.toHaveBeenCalled()
  })
  it('guard is called with the analytics action shape', async () => {
    await run(BASE_QUERY)
    expect(vi.mocked(guardProjectRoute)).toHaveBeenCalledWith(
      expect.anything(),
      CLAIMS,
      expect.objectContaining({ projectRef: 'proj-x', action: 'analytics:Read' })
    )
  })
  it('assembles the multi shape: buckets → data[].values, series metadata per attribute', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        { attribute: 'avg_cpu_usage', bucket: 1751760000, value: 40 },
        { attribute: 'avg_cpu_usage', bucket: 1751760060, value: 60 },
        { attribute: 'ram_usage', bucket: 1751760000, value: 30 },
      ] as never,
      error: undefined,
    })
    const res = await run(BASE_QUERY)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.data).toEqual([
      {
        period_start: new Date(1751760000 * 1000).toISOString(),
        values: { avg_cpu_usage: 40, ram_usage: 30 },
      },
      { period_start: new Date(1751760060 * 1000).toISOString(), values: { avg_cpu_usage: 60 } },
    ])
    expect(body.series.avg_cpu_usage).toEqual({
      format: '%',
      yAxisLimit: 100,
      total: 60, // gauge → latest bucket value
      totalAverage: 50,
    })
    expect(body.series.ram_usage.totalAverage).toBe(30)
  })
  it('rate attributes fold total as window sum', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        { attribute: 'network_receive_bytes', bucket: 1751760000, value: 100 },
        { attribute: 'network_receive_bytes', bucket: 1751760060, value: 300 },
      ] as never,
      error: undefined,
    })
    const res = await run({ ...BASE_QUERY, attributes: 'network_receive_bytes' })
    expect(res._getJSONData().series.network_receive_bytes).toEqual({
      format: 'bytes-per-second',
      yAxisLimit: 0,
      total: 400,
      totalAverage: 200,
    })
  })
  it('unknown attributes: zeroed series, excluded from SQL; known-empty stays honest', async () => {
    const res = await run({ ...BASE_QUERY, attributes: 'avg_cpu_usage,made_up_attr' })
    const body = res._getJSONData()
    expect(body.data).toEqual([])
    expect(body.series.made_up_attr).toEqual({
      format: '',
      yAxisLimit: 0,
      total: 0,
      totalAverage: 0,
    })
    expect(body.series.avg_cpu_usage.totalAverage).toBe(0)
    const [opts] = vi.mocked(executePlatformQuery).mock.calls[0]
    expect(opts.parameters).toContain('avg_cpu_usage')
    expect(opts.parameters!.join('|')).not.toContain('made_up_attr')
  })
  it('bucket seconds follow the interval map; databaseIdentifier is ignored', async () => {
    await run({ ...BASE_QUERY, interval: '30m', databaseIdentifier: 'replica-1' })
    const [opts] = vi.mocked(executePlatformQuery).mock.calls[0]
    expect(opts.parameters).toContain(1800)
  })
  it('samples query failure → 500 existing error shape', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('platform db down'),
    })
    const res = await run(BASE_QUERY)
    expect(res._getStatusCode()).toBe(500)
    expect(res._getJSONData().error.message).toContain('platform db down')
  })
})
