// [self-platform] Task 12: table-driven RBAC guard coverage for the 10
// pg-meta listing routes. NOTE (deviation from the task brief's skeleton):
// these routes fetch via `fetchGet` (@/data/fetchers) against the selected
// project's pg-meta URL, NOT `executeQuery` (@/lib/api/self-hosted/query) —
// that helper belongs to the query route only. The "no data access on deny"
// assertion below targets `fetchGet` accordingly; verified against each route.
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchGet } from '@/data/fetchers'
import { resolveFleetPgMetaRequest } from '@/lib/api/self-platform/pg-meta'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/data/fetchers', () => ({ fetchGet: vi.fn() }))
vi.mock('@/lib/api/self-platform/pg-meta', () => ({ resolveFleetPgMetaRequest: vi.fn() }))

const ROUTES = [
  'column-privileges',
  'extensions',
  'foreign-tables',
  'materialized-views',
  'policies',
  'publications',
  'tables',
  'triggers',
  'types',
  'views',
] as const

describe.each(ROUTES)('pg-meta/[ref]/%s guard', (name) => {
  beforeEach(() => {
    vi.mocked(guardProjectRoute).mockReset()
    vi.mocked(fetchGet).mockReset().mockResolvedValue({ data: [], error: undefined })
    vi.mocked(resolveFleetPgMetaRequest)
      .mockReset()
      .mockResolvedValue({
        baseUrl: 'http://project-meta.example/pg',
        headers: { 'x-connection-encrypted': 'SERVER_ENC' },
      })
  })

  it('declares tenant:Sql:Admin:Read and stops on deny', async () => {
    const { handler } = await import(`./${name}`)
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, { sub: 'g-1' })

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'tenant:Sql:Admin:Read',
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(vi.mocked(fetchGet)).not.toHaveBeenCalled()
    expect(resolveFleetPgMetaRequest).not.toHaveBeenCalled()
  })

  it('allows through and fetches when guardProjectRoute permits', async () => {
    const { handler } = await import(`./${name}`)
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any, { sub: 'g-1' })

    expect(res._getStatusCode()).toBe(200)
    expect(resolveFleetPgMetaRequest).toHaveBeenCalledWith('proj-b', req.headers)
    expect(vi.mocked(fetchGet)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchGet).mock.calls[0][0]).toMatch(/^http:\/\/project-meta\.example\/pg\//)
    expect(vi.mocked(fetchGet).mock.calls[0][1]).toMatchObject({
      headers: { 'x-connection-encrypted': 'SERVER_ENC' },
    })
  })
})
