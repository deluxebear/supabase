import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { detachProject, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { clearHealthCache } from '@/lib/api/self-platform/health'
import {
  getProjectManagementBinding,
  revokeProjectManagementBinding,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardProjectRoute: vi.fn(),
  checkPermission: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/attachment', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detachProject: vi.fn(),
  requireProjectCapability: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/health', () => ({ clearHealthCache: vi.fn() }))
vi.mock('@/lib/api/self-platform/management-trust', () => ({
  getProjectManagementBinding: vi.fn(),
  revokeProjectManagementBinding: vi.fn(),
}))
// GET-path deps the module imports; DELETE tests never reach them.
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload
const del = (ref: string | string[]) => createMocks({ method: 'DELETE', query: { ref } })

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(requireProjectCapability).mockReset().mockResolvedValue()
  vi.mocked(detachProject).mockReset().mockResolvedValue({
    projectRef: 'team-a',
    detachedAt: '2026-07-15T00:00:00.000Z',
    targetCleanupPending: false,
    infrastructureDeleted: false,
  })
  vi.mocked(getProjectManagementBinding).mockReset().mockResolvedValue(null)
  vi.mocked(revokeProjectManagementBinding).mockReset().mockResolvedValue({
    bindingId: 'binding-a',
    targetRevoked: true,
    targetCleanupPending: false,
  })
})

describe('DELETE /platform/projects/[ref] (self-platform)', () => {
  it('happy path → guard, capability check, and non-destructive detach', async () => {
    const { req, res } = del('team-a')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Delete',
      projectRef: 'team-a',
      resource: 'projects',
    })
    expect(requireProjectCapability).toHaveBeenCalledWith('team-a', 'project.detach')
    expect(detachProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'team-a', actor: 'g-owner' })
    )
    expect(clearHealthCache).toHaveBeenCalledWith('team-a')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({
      ref: 'team-a',
      infrastructureDeleted: false,
      targetCleanupPending: false,
    })
  })

  it('revokes management trust before tombstoning an attached project', async () => {
    vi.mocked(getProjectManagementBinding).mockResolvedValue({ id: 'binding-a' } as never)
    const { req, res } = del('team-a')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(revokeProjectManagementBinding).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'team-a', actor: 'g-owner' })
    )
    expect(vi.mocked(revokeProjectManagementBinding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(detachProject).mock.invocationCallOrder[0]
    )
    expect(res._getStatusCode()).toBe(200)
  })

  it('guard denial short-circuits before the data layer', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const { req, res } = del('team-a')
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(detachProject).not.toHaveBeenCalled()
  })

  it('default is refused AFTER the guard (no info leak), 400', async () => {
    const { req, res } = del('default')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(guardProjectRoute).toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'The default project cannot be detached' })
    expect(detachProject).not.toHaveBeenCalled()
  })

  it('array ref → 400 before the guard', async () => {
    const { req, res } = del(['a', 'b'])
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })

  it('unsupported method → 405 with Allow GET,DELETE', async () => {
    const { req, res } = createMocks({ method: 'PUT', query: { ref: 'x' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    // M6.1 added PATCH to the self-platform method set.
    expect(res._getHeaders().allow).toEqual(['GET', 'PATCH', 'DELETE'])
  })
})
