import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cancelFleetOperation, retryFleetOperation } from '@/lib/api/self-platform/fleet-operations'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler as cancelHandler } from '@/pages/api/platform/fleet/v1/projects/[ref]/operations/[operationId]/cancel'
import { handler as retryHandler } from '@/pages/api/platform/fleet/v1/projects/[ref]/operations/[operationId]/retry'

vi.mock('@/lib/api/self-platform/fleet-operations', () => ({
  cancelFleetOperation: vi.fn(),
  retryFleetOperation: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { platformIdentity: true },
}))

describe('Fleet operation transition APIs', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
  })

  it.each([
    ['cancel', cancelHandler, cancelFleetOperation],
    ['retry', retryHandler, retryFleetOperation],
  ] as const)(
    'proxies %s with update RBAC and exact project identity',
    async (_, handler, request) => {
      vi.mocked(request).mockResolvedValue({ id: 'op-a', state: 'queued' } as never)
      const { req, res } = createMocks({
        method: 'POST',
        query: { ref: 'project-a', operationId: 'op-a' },
        headers: { 'x-correlation-id': 'corr-a' },
      })
      const claims = { sub: 'user-a' } as JwtPayload
      await handler(req, res, claims)
      expect(guardProjectRoute).toHaveBeenCalledWith(res, claims, {
        action: expect.any(String),
        projectRef: 'project-a',
      })
      expect(request).toHaveBeenCalledWith({
        projectRef: 'project-a',
        operationId: 'op-a',
        actor: 'user-a',
        correlationId: 'corr-a',
      })
      expect(res._getStatusCode()).toBe(200)
    }
  )
})
