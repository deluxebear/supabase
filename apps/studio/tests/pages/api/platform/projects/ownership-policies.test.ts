import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { setProjectOwnershipPolicy } from '@/lib/api/self-platform/ownership-policy'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler } from '@/pages/api/platform/projects/[ref]/ownership-policies'

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
vi.mock('@/lib/api/self-platform/ownership-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/ownership-policy')>()),
  listProjectOwnershipPolicies: vi.fn(),
  setProjectOwnershipPolicy: vi.fn(),
}))

function response() {
  return {
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
}

beforeEach(() => vi.clearAllMocks())

describe('project ownership policy API', () => {
  it('denies before capability and store access when project RBAC fails', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const res = response()
    await handler(
      {
        method: 'PUT',
        query: { ref: 'project-a' },
        body: { domain: 'auth', ownershipMode: 'direct-managed', expectedRevision: 1 },
      } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(requireProjectCapability).not.toHaveBeenCalled()
    expect(setProjectOwnershipPolicy).not.toHaveBeenCalled()
  })

  it('checks static and Agent capabilities before direct-managed update', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(requireProjectCapability).mockResolvedValue(undefined)
    vi.mocked(setProjectOwnershipPolicy).mockResolvedValue({
      projectRef: 'project-a',
      domain: 'auth',
      ownershipMode: 'direct-managed',
      adapter: 'compose',
      fieldOwners: { '*': 'fleet' },
      policyRevision: 2,
      casToken: '00000000-0000-4000-8000-000000000010',
      driftState: 'unknown',
      blockers: [],
      lastOperationId: null,
      lastObservedGeneration: null,
      lastObservedDigest: null,
      lastObservedAt: null,
      desiredRevision: null,
      desiredGeneration: null,
      desiredDigest: null,
      observedRevision: null,
      observedGeneration: null,
      observedDigest: null,
      updatedAt: '2026-07-15T00:00:00Z',
    })
    const res = response()
    const body = { domain: 'auth', ownershipMode: 'direct-managed', expectedRevision: 1 }
    await handler(
      { method: 'PUT', query: { ref: 'project-a' }, body, headers: {} } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(requireProjectCapability).toHaveBeenNthCalledWith(
      1,
      'project-a',
      'configuration.ownership.update'
    )
    expect(requireProjectCapability).toHaveBeenNthCalledWith(
      2,
      'project-a',
      'runtime.config.reconcile'
    )
    expect(setProjectOwnershipPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'project-a', policy: body, actor: 'owner-a' })
    )
    expect(res.statusCode).toBe(200)
  })

  it('does not require an executable Agent capability for GitOps mode', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(requireProjectCapability).mockResolvedValue(undefined)
    vi.mocked(setProjectOwnershipPolicy).mockResolvedValue({} as never)
    const res = response()
    await handler(
      {
        method: 'PUT',
        query: { ref: 'project-a' },
        body: { domain: 'storage', ownershipMode: 'gitops-managed', expectedRevision: 0 },
        headers: {},
      } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(requireProjectCapability).toHaveBeenCalledTimes(1)
    expect(requireProjectCapability).toHaveBeenCalledWith(
      'project-a',
      'configuration.ownership.update'
    )
  })
})
