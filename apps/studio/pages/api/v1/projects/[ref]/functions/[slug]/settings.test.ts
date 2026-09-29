import { PermissionAction } from '@supabase/shared-types/out/constants'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { updateFunctionDeploymentSettings } from '@/lib/api/self-platform/function-deployments'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
}))
vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/function-deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/function-deployments')>()),
  getFunctionDeployment: vi.fn(),
  getFunctionDeploymentSettings: vi.fn(),
  updateFunctionDeploymentSettings: vi.fn(),
}))

describe('Fleet function settings', () => {
  beforeEach(() => {
    vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
    vi.mocked(updateFunctionDeploymentSettings).mockReset()
  })

  it('requires write permission and queues an update with the selected generation', async () => {
    vi.mocked(updateFunctionDeploymentSettings).mockResolvedValue({
      projectRef: 'project-d',
      slug: 'hello-world',
      generation: 2,
      createdAt: '2026-09-29T00:00:00Z',
      updatedAt: '2026-09-29T00:01:00Z',
    } as never)
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'project-d', slug: 'hello-world' },
      headers: { 'if-match': '1' },
      body: { name: 'hello-world', verify_jwt: false },
    })

    await handler(req as never, res as never, { sub: 'owner-a' } as never)

    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: PermissionAction.FUNCTIONS_WRITE,
      projectRef: 'project-d',
    })
    expect(updateFunctionDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: 'project-d',
        slug: 'hello-world',
        verifyJwt: false,
        expectedGeneration: 1,
        actor: 'owner-a',
      })
    )
    expect(res._getStatusCode()).toBe(202)
  })

  it('rejects updates without a generation before calling the deployment service', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'project-d', slug: 'hello-world' },
      body: { name: 'hello-world', verify_jwt: false },
    })

    await handler(req as never, res as never, { sub: 'owner-a' } as never)

    expect(res._getStatusCode()).toBe(400)
    expect(updateFunctionDeploymentSettings).not.toHaveBeenCalled()
  })
})
