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

describe('M6.2 Logflare timeouts', () => {
  it('log-drains list fetch carries an AbortSignal', async () => {
    getAnalyticsTarget.mockResolvedValueOnce({
      baseUrl: 'http://lf:4000',
      token: 't',
      projectParam: 'default',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
    const { handler } = await import('./log-drains')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    vi.unstubAllGlobals()
  })
})

// [self-platform] mechanical fix: the brief's InvalidAnalyticsParams hoisted
// binding is unused (tsc noUnusedLocals) — the 400-mapping test below
// exercises the REAL class via vi.importActual (as `Real`) instead. Dropped
// from the destructure/factory; no test semantics change.
const { isSubstitutedEndpoint, retrieveSubstitutedAnalyticsData } = vi.hoisted(() => ({
  isSubstitutedEndpoint: vi.fn(),
  retrieveSubstitutedAnalyticsData: vi.fn(),
}))
vi.mock('@/lib/api/self-hosted/analytics-substitutes', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isSubstitutedEndpoint,
  retrieveSubstitutedAnalyticsData,
}))

describe('M6.2 endpoints/[name] substitution routing', () => {
  // [self-platform] mock-reset gap fix (mechanical, not a semantic change):
  // without this, call history for these two hoisted mocks bleeds across
  // `it()` blocks in this file (no global clearMocks/restoreMocks config),
  // so "not.toHaveBeenCalled()" assertions here would see stale calls from
  // earlier tests. Same reset pattern as this file's top-level beforeEach.
  beforeEach(() => {
    isSubstitutedEndpoint.mockReset()
    retrieveSubstitutedAnalyticsData.mockReset()
  })

  it('substituted name goes through the substitute, not the verbatim forwarder', async () => {
    isSubstitutedEndpoint.mockReturnValue(true)
    retrieveSubstitutedAnalyticsData.mockResolvedValueOnce({
      data: { result: [] },
      error: undefined,
    })
    const { handler } = await import('./endpoints/[name]')
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'default', name: 'usage.api-counts', interval: '1hr' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(retrieveSubstitutedAnalyticsData).toHaveBeenCalledWith({
      name: 'usage.api-counts',
      params: { interval: '1hr' },
      projectRef: 'default',
    })
    expect(retrieveAnalyticsData).not.toHaveBeenCalled()
  })

  it('logs.all still forwards verbatim', async () => {
    isSubstitutedEndpoint.mockReturnValue(false)
    retrieveAnalyticsData.mockResolvedValueOnce({ data: { result: [] }, error: undefined })
    const { handler } = await import('./endpoints/[name]')
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'default', name: 'logs.all', sql: 'select 1' },
    })
    await handler(req as any, res as any)
    expect(retrieveAnalyticsData).toHaveBeenCalled()
    expect(retrieveSubstitutedAnalyticsData).not.toHaveBeenCalled()
  })

  it('InvalidAnalyticsParams → 400 with the message', async () => {
    isSubstitutedEndpoint.mockReturnValue(true)
    const { InvalidAnalyticsParams: Real } = await vi.importActual<any>(
      '@/lib/api/self-hosted/analytics-substitutes'
    )
    retrieveSubstitutedAnalyticsData.mockRejectedValueOnce(new Real('Invalid interval'))
    const { handler } = await import('./endpoints/[name]')
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'default', name: 'usage.api-counts', interval: 'wat' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid interval' })
  })
})

describe('M6.2 log-drains/[uuid] single-response on fetch failure', () => {
  it.each([['PUT'], ['DELETE']])(
    '%s sends exactly one 500 when the Logflare fetch rejects',
    async (method) => {
      getAnalyticsTarget.mockResolvedValueOnce({
        baseUrl: 'http://lf:4000',
        token: 't',
        projectParam: 'default',
      })
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }))
      )
      const { handler } = await import('./log-drains/[uuid]')
      const { req, res } = createMocks({
        method: method as any,
        query: { ref: 'proj-b', uuid: 'u-1' },
        body: {},
      })
      await handler(req as any, res as any)
      expect(res._getStatusCode()).toBe(500)
      expect(res._getJSONData()).toEqual({
        error: { message: `Error ${method === 'PUT' ? 'updating' : 'deleting'} log drain` },
      })
      vi.unstubAllGlobals()
    }
  )
})
