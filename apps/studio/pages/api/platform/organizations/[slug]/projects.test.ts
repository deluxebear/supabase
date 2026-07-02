import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './projects'
import { getOrganizationBySlug } from '@/lib/api/self-platform/organizations'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/organizations', () => ({
  getOrganizationBySlug: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

describe('GET /platform/organizations/{slug}/projects (self-platform)', () => {
  it('returns the paginated project list for a known org', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({
      id: 1,
      slug: 'default',
      name: 'Default Organization',
    })
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.pagination).toEqual({ count: 1, limit: expect.any(Number), offset: 0 })
    expect(body.projects[0]).toMatchObject({
      ref: 'default',
      organization_slug: 'default',
      is_branch: false,
      preview_branch_refs: [],
      databases: [{ identifier: 'default', type: 'PRIMARY' }],
    })
  })

  it('returns 404 for an unknown org slug', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(null)
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'nope' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Organization not found' })
  })

  it('returns 405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
