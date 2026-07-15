import { createMocks } from 'node-mocks-http'
import { expect, it, vi } from 'vitest'

import { getOperationSummary } from '@/lib/api/self-platform/desired-state'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import route from '@/pages/api/platform/fleet/v1/projects/[ref]/operations/[operationId]'

vi.mock('@/lib/api/self-platform/desired-state', () => ({ getOperationSummary: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'embedded',
  STUDIO_CAPABILITIES: { platformIdentity: false },
}))

it('keeps the Fleet operation API unavailable in Embedded Studio', async () => {
  const { req, res } = createMocks({
    method: 'GET',
    query: { ref: 'default', operationId: 'op-a' },
  })
  await route(req, res)
  expect(res._getStatusCode()).toBe(404)
  expect(guardProjectRoute).not.toHaveBeenCalled()
  expect(getOperationSummary).not.toHaveBeenCalled()
})
