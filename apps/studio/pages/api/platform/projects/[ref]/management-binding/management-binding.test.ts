import { describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { bindProjectManagementTarget } from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/attachment', () => ({
  CapabilityUnavailable: class CapabilityUnavailable extends Error {},
  requireProjectCapability: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/management-trust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/management-trust')>()),
  bindProjectManagementTarget: vi.fn(),
  getProjectManagementBinding: vi.fn(),
  revokeProjectManagementBinding: vi.fn(),
}))

function response() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(value: unknown) {
      this.payload = value
      return this
    },
    setHeader: vi.fn(),
  }
  return res
}

describe('project management binding API', () => {
  it('stops before capability and store access when project RBAC denies the request', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const res = response()
    await handler(
      { method: 'PUT', query: { ref: 'project-a' }, body: {} } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(requireProjectCapability).not.toHaveBeenCalled()
    expect(bindProjectManagementTarget).not.toHaveBeenCalled()
  })

  it('checks the project capability before creating an isolated binding', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(requireProjectCapability).mockResolvedValue(undefined)
    vi.mocked(bindProjectManagementTarget).mockResolvedValue({ id: 'binding-a' } as never)
    const res = response()
    const body = {
      managementTargetId: '00000000-0000-4000-8000-00000000000a',
      executionTarget: 'compose://project-a',
      deploymentKind: 'compose',
      allowedCapabilityPrefixes: ['runtime.'],
    }
    await handler(
      { method: 'PUT', query: { ref: 'project-a' }, body, headers: {} } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(requireProjectCapability).toHaveBeenCalledWith('project-a', 'management.target.bind')
    expect(bindProjectManagementTarget).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'project-a', binding: body, actor: 'owner-a' })
    )
    expect(res.statusCode).toBe(201)
  })
})
