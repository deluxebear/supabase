import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './index'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

describe('GET /platform/projects (self-platform)', () => {
  it('returns V2 paginated shape when Version: 2 header present', async () => {
    const { req, res } = createMocks({ method: 'GET', headers: { version: '2' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.pagination).toEqual({ count: 1, limit: expect.any(Number), offset: 0 })
    expect(body.projects[0]).toMatchObject({
      ref: 'default',
      organization_slug: 'default',
      preview_branch_refs: [],
      status: 'ACTIVE_HEALTHY',
    })
  })

  it('keeps the legacy V1 array without the header', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)
    expect(Array.isArray(res._getJSONData())).toBe(true)
  })
})
