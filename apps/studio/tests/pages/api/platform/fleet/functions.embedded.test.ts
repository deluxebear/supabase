import { createMocks } from 'node-mocks-http'
import { expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import route from '@/pages/api/platform/fleet/v1/projects/[ref]/functions'

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'embedded',
  STUDIO_CAPABILITIES: { remoteFunctionsDeployment: false },
}))

it('keeps the Fleet functions API unavailable and non-enumerating in Embedded Studio', async () => {
  const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
  await route(req, res)
  expect(res._getStatusCode()).toBe(404)
  expect(res._getJSONData()).toEqual({ code: 'project_not_found', message: 'Not found' })
  expect(guardProjectRoute).not.toHaveBeenCalled()
})
