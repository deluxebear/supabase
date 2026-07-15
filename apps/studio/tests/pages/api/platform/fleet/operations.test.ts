import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getOperationSummary } from '@/lib/api/self-platform/desired-state'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler } from '@/pages/api/platform/fleet/v1/projects/[ref]/operations/[operationId]'

vi.mock('@/lib/api/self-platform/desired-state', () => ({ getOperationSummary: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { platformIdentity: true },
}))

describe('Fleet operation summary API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
  })

  it('authorizes and queries with the exact project ref', async () => {
    vi.mocked(getOperationSummary).mockResolvedValue({ operation_id: 'op-a' } as never)
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'project-a', operationId: 'op-a' },
    })
    const claims = { sub: 'user-a' } as JwtPayload
    await handler(req, res, claims)
    expect(guardProjectRoute).toHaveBeenCalledWith(res, claims, {
      action: expect.any(String),
      projectRef: 'project-a',
    })
    expect(getOperationSummary).toHaveBeenCalledWith('project-a', 'op-a')
    expect(res._getStatusCode()).toBe(200)
  })

  it('does not query after RBAC denial', async () => {
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'project-b', operationId: 'op-a' },
    })
    await handler(req, res, { sub: 'user-a' } as JwtPayload)
    expect(getOperationSummary).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(403)
  })

  it('keeps cross-project operation misses non-enumerating', async () => {
    vi.mocked(getOperationSummary).mockResolvedValue(null)
    const { req, res } = createMocks({
      method: 'GET',
      query: { ref: 'project-b', operationId: 'op-a' },
    })
    await handler(req, res, { sub: 'user-a' } as JwtPayload)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toMatchObject({ code: 'project_not_found' })
  })
})
