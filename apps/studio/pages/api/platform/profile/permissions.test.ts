import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './permissions'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

describe('GET /platform/profile/permissions (self-platform, M1)', () => {
  it('returns a single org-wide wildcard grant for the default org', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([
      {
        actions: ['%'],
        condition: null,
        organization_id: 1,
        organization_slug: 'default',
        project_ids: [],
        project_refs: [],
        resources: ['%'],
        restrictive: false,
      },
    ])
  })
})
