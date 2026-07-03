import assert from 'node:assert'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsNotConfigured } from '@/lib/api/self-hosted/logs'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] Task 14: RBAC guards now gate these routes. Stub them open
// so this sweep keeps exercising business logic — the guard's own behavior
// is covered by analytics-rbac.test.ts.
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  guardProjectRoute: vi.fn().mockResolvedValue(true),
}))

const { getAnalyticsTarget, retrieveAnalyticsData } = vi.hoisted(() => ({
  getAnalyticsTarget: vi.fn(),
  retrieveAnalyticsData: vi.fn(),
}))
vi.mock('@/lib/api/self-hosted/logs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAnalyticsTarget,
  retrieveAnalyticsData,
}))

beforeEach(() => {
  getAnalyticsTarget.mockReset()
  retrieveAnalyticsData.mockReset()
})

describe('analytics endpoints/[name] per-ref', () => {
  it('404s when analytics is not configured for the project', async () => {
    retrieveAnalyticsData.mockRejectedValueOnce(new AnalyticsNotConfigured('proj-b'))
    const { handler } = await import('./endpoints/[name]')
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', name: 'logs.all' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({
      message: 'Analytics is not configured for this project',
    })
  })

  it('404s unknown ref', async () => {
    retrieveAnalyticsData.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./endpoints/[name]')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost', name: 'logs.all' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it.each([
    [{ ref: ['a', 'b'], name: 'logs.all' }, 'Invalid ref parameter'],
    [{ ref: 'proj-b' }, 'Invalid name parameter'],
  ])('400s malformed params on endpoints/[name]: %j', async (query, message) => {
    const { handler } = await import('./endpoints/[name]')
    const { req, res } = createMocks({ method: 'GET', query })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message })
  })
})

describe('analytics log-drains per-ref', () => {
  it('list drains hits the per-ref Logflare with the per-ref token', async () => {
    getAnalyticsTarget.mockResolvedValueOnce({
      baseUrl: 'http://lf-b:4000',
      token: 'tok-b',
      projectParam: 'default',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./log-drains')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(getAnalyticsTarget).toHaveBeenCalledWith('proj-b')
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://lf-b:4000/api/backends?metadata%5Btype%5D=log-drain'
    )
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-b')
    vi.unstubAllGlobals()
  })

  it('404s when analytics is not configured', async () => {
    getAnalyticsTarget.mockRejectedValueOnce(new AnalyticsNotConfigured('proj-b'))
    const { handler } = await import('./log-drains')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
  })

  it('maps analytics-target AssertionError to a descriptive 500', async () => {
    let assertionError: Error
    try {
      assert(false, 'LOGFLARE_URL is required')
    } catch (e) {
      assertionError = e as Error
    }
    getAnalyticsTarget.mockRejectedValueOnce(assertionError!)
    const { handler } = await import('./log-drains')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(500)
    expect(res._getJSONData()).toEqual({ error: { message: 'LOGFLARE_URL is required' } })
  })

  it('[uuid] delete hits the per-ref Logflare', async () => {
    getAnalyticsTarget.mockResolvedValueOnce({
      baseUrl: 'http://lf-b:4000',
      token: 'tok-b',
      projectParam: 'default',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./log-drains/[uuid]')
    const { req, res } = createMocks({ method: 'DELETE', query: { ref: 'proj-b', uuid: 'u-1' } })
    await handler(req as any, res as any)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://lf-b:4000/api/backends/u-1')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-b')
    vi.unstubAllGlobals()
  })
})
