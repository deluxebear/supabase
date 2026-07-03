import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { DEFAULT_PROJECT } from '@/lib/constants/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/list-user-projects', () => ({
  listAllProjectsV2: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

describe('GET /platform/projects (self-platform)', () => {
  it('returns the registry-backed V2 paginated shape when Version: 2 header present', async () => {
    vi.mocked(listAllProjectsV2).mockResolvedValue({
      pagination: { count: 2, limit: 100, offset: 0 },
      projects: [
        { ref: 'proj-a', organization_slug: 'acme', preview_branch_refs: [] },
        { ref: 'proj-b', organization_slug: 'other', preview_branch_refs: [] },
      ],
    } as any)
    const { req, res } = createMocks({ method: 'GET', headers: { version: '2' } })
    await handler(req as any, res as any)
    expect(listAllProjectsV2).toHaveBeenCalledWith(100, 0)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(body.projects).toHaveLength(2)
    expect(body.projects[0]).toMatchObject({ ref: 'proj-a', organization_slug: 'acme' })
  })

  it('keeps the legacy V1 array without the header, unchanged', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([DEFAULT_PROJECT])
    expect(listAllProjectsV2).not.toHaveBeenCalled()
  })

  it('returns 405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })

  it('returns 400 for an invalid limit parameter', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      headers: { version: '2' },
      query: { limit: 'abc' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Invalid pagination parameters' })
    expect(listAllProjectsV2).not.toHaveBeenCalled()
  })

  it('passes through valid limit/offset query params', async () => {
    vi.mocked(listAllProjectsV2).mockResolvedValue({
      pagination: { count: 1, limit: 1, offset: 1 },
      projects: [],
    } as any)
    const { req, res } = createMocks({
      method: 'GET',
      headers: { version: '2' },
      query: { limit: '1', offset: '1' },
    })
    await handler(req as any, res as any)
    expect(listAllProjectsV2).toHaveBeenCalledWith(1, 1)
    expect(res._getStatusCode()).toBe(200)
  })

  it('clamps limit above 1000 but leaves offset above 1000 unclamped', async () => {
    vi.mocked(listAllProjectsV2).mockResolvedValue({
      pagination: { count: 0, limit: 1000, offset: 1500 },
      projects: [],
    } as any)
    const { req, res } = createMocks({
      method: 'GET',
      headers: { version: '2' },
      query: { limit: '5000', offset: '1500' },
    })
    await handler(req as any, res as any)
    expect(listAllProjectsV2).toHaveBeenCalledWith(1000, 1500)
    expect(res._getStatusCode()).toBe(200)
  })
})
