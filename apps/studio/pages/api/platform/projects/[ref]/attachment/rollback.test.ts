import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './rollback'
import {
  requireProjectCapability,
  rollbackStagedAttachment,
} from '@/lib/api/self-platform/attachment'
import {
  getProjectManagementBinding,
  revokeProjectManagementBinding,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/attachment', () => ({
  requireProjectCapability: vi.fn(),
  rollbackStagedAttachment: vi.fn(),
  CapabilityUnavailable: class CapabilityUnavailable extends Error {},
}))
vi.mock('@/lib/api/self-platform/management-trust', () => ({
  getProjectManagementBinding: vi.fn(),
  revokeProjectManagementBinding: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const claims = { sub: 'owner-a' } as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(requireProjectCapability).mockReset().mockResolvedValue()
  vi.mocked(getProjectManagementBinding).mockReset().mockResolvedValue(null)
  vi.mocked(revokeProjectManagementBinding)
    .mockReset()
    .mockResolvedValue({} as never)
  vi.mocked(rollbackStagedAttachment).mockReset().mockResolvedValue({
    projectRef: 'project-a',
    rolledBackAt: '2026-07-16T00:00:00.000Z',
    infrastructureDeleted: false,
  })
})

describe('POST /platform/projects/[ref]/attachment/rollback', () => {
  it('rolls back staged control-plane state without deleting infrastructure', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'project-a' },
      headers: { 'x-correlation-id': 'correlation-a' },
    })
    await handler(req as never, res as never, claims)

    expect(guardProjectRoute).toHaveBeenCalledWith(
      res,
      claims,
      expect.objectContaining({ action: 'write:Delete', projectRef: 'project-a' })
    )
    expect(rollbackStagedAttachment).toHaveBeenCalledWith({
      projectRef: 'project-a',
      actor: 'owner-a',
      correlationId: 'correlation-a',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({ infrastructureDeleted: false })
  })

  it('revokes an existing management binding before deleting staged state', async () => {
    vi.mocked(getProjectManagementBinding).mockResolvedValue({ id: 'binding-a' } as never)
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'project-a' } })
    await handler(req as never, res as never, claims)

    expect(revokeProjectManagementBinding).toHaveBeenCalled()
    expect(vi.mocked(revokeProjectManagementBinding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(rollbackStagedAttachment).mock.invocationCallOrder[0]
    )
    expect(res._getStatusCode()).toBe(200)
  })

  it('does not mutate after RBAC denial', async () => {
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ code: 'forbidden', message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'project-a' } })
    await handler(req as never, res as never, claims)

    expect(res._getStatusCode()).toBe(403)
    expect(rollbackStagedAttachment).not.toHaveBeenCalled()
  })
})
