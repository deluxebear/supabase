import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getFleetOperation } from '@/lib/api/self-platform/fleet-operations'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler } from '@/pages/api/platform/fleet/v1/projects/[ref]/operations/[operationId]'

vi.mock('@/lib/api/self-platform/fleet-operations', () => ({ getFleetOperation: vi.fn() }))
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
    vi.mocked(getFleetOperation).mockResolvedValue({ id: 'op-a' } as never)
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
    expect(getFleetOperation).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'project-a', operationId: 'op-a', actor: 'user-a' })
    )
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
    expect(getFleetOperation).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(403)
  })
})
