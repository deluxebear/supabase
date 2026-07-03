// [self-platform] Task 14: table-driven RBAC guard coverage for the 3
// analytics [ref] routes. Mirrors storage-rbac.test.ts's shape: guard is
// fully mocked here (its own decision logic is covered by enforce.test.ts);
// this suite pins (a) the guard is invoked with the table's action +
// projectRef, (b) a deny short-circuits with 403 before the route's first
// data-access call, and (c) an allow lets that data access run.
//
// Data access per route (identified from source, not assumed):
//   - endpoints/[name]: retrieveAnalyticsData (@/lib/api/self-hosted/logs)
//   - log-drains, log-drains/[uuid]: getAnalyticsTarget
//     (@/lib/api/self-hosted/logs) — gates the Logflare baseUrl/token
//     resolution that every method needs before touching `fetch`.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

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
  vi.mocked(guardProjectRoute).mockReset()
  getAnalyticsTarget.mockReset().mockResolvedValue({
    baseUrl: 'http://lf-b:4000',
    token: 'tok-b',
    projectParam: 'default',
  })
  retrieveAnalyticsData.mockReset().mockResolvedValue({ data: { result: [] }, error: undefined })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
})

describe('analytics/endpoints/[name] guard', () => {
  it('declares analytics:Read and stops on deny before retrieveAnalyticsData', async () => {
    const { handler } = await import('./endpoints/[name]')
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'proj-b', name: 'logs.all' },
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: PermissionAction.ANALYTICS_READ,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(retrieveAnalyticsData).not.toHaveBeenCalled()
  })

  it('allows through and fetches when guardProjectRoute permits (POST is also a read)', async () => {
    const { handler } = await import('./endpoints/[name]')
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b', name: 'logs.all' },
      body: {},
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: PermissionAction.ANALYTICS_READ,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(retrieveAnalyticsData).toHaveBeenCalledTimes(1)
  })
})

const LOG_DRAINS_ROUTES: Array<[path: string, method: string, action: string, query: object]> = [
  ['./log-drains', 'GET', PermissionAction.ANALYTICS_ADMIN_READ, {}],
  ['./log-drains', 'POST', PermissionAction.ANALYTICS_ADMIN_WRITE, {}],
  ['./log-drains/[uuid]', 'GET', PermissionAction.ANALYTICS_ADMIN_READ, { uuid: 'u-1' }],
  ['./log-drains/[uuid]', 'PUT', PermissionAction.ANALYTICS_ADMIN_WRITE, { uuid: 'u-1' }],
  ['./log-drains/[uuid]', 'DELETE', PermissionAction.ANALYTICS_ADMIN_WRITE, { uuid: 'u-1' }],
]

describe.each(LOG_DRAINS_ROUTES)('analytics %s %s guard', (path, method, action, extraQuery) => {
  it(`declares ${action} and stops on deny before getAnalyticsTarget`, async () => {
    const { handler } = await import(path)
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'proj-b', ...extraQuery },
      body: {},
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(getAnalyticsTarget).not.toHaveBeenCalled()
  })

  it('allows through and reaches getAnalyticsTarget when guardProjectRoute permits', async () => {
    const { handler } = await import(path)
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: method as any,
      query: { ref: 'proj-b', ...extraQuery },
      body: {},
    })
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(getAnalyticsTarget).toHaveBeenCalledWith('proj-b')
    expect(res._getStatusCode()).not.toBe(403)
  })
})
