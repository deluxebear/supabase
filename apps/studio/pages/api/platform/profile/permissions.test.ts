import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './permissions'
import { getOrganizationBySlug } from '@/lib/api/self-platform/organizations'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/organizations', () => ({
  getOrganizationBySlug: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

describe('GET /platform/profile/permissions (self-platform, M1)', () => {
  it('returns a single org-wide wildcard grant using the looked-up default org', async () => {
    // I2: use a non-1 id so this can't pass by coincidence with the old
    // hardcoded `organization_id: 1` behavior.
    vi.mocked(getOrganizationBySlug).mockResolvedValue({
      id: 42,
      slug: 'default',
      name: 'Default',
    })
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)
    expect(getOrganizationBySlug).toHaveBeenCalledWith('default')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([
      {
        actions: ['%'],
        condition: null,
        organization_id: 42,
        organization_slug: 'default',
        project_ids: [],
        project_refs: [],
        resources: ['%'],
        restrictive: false,
      },
    ])
  })

  it('returns an empty permissions array when the default org is not found', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(null)
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([])
  })
})
