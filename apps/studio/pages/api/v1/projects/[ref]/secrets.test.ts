import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './secrets'
import {
  deleteFunctionSecrets,
  listFunctionSecretMetadata,
  upsertFunctionSecrets,
} from '@/lib/api/self-platform/function-secrets'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { remoteFunctionsDeployment: true },
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/function-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/self-platform/function-secrets')>()
  return {
    ...actual,
    listFunctionSecretMetadata: vi.fn(),
    upsertFunctionSecrets: vi.fn(),
    deleteFunctionSecrets: vi.fn(),
  }
})

const claims = { sub: 'operator-a' } as JwtPayload

describe('Fleet function secrets API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(listFunctionSecretMetadata).mockResolvedValue([])
    vi.mocked(upsertFunctionSecrets).mockResolvedValue()
    vi.mocked(deleteFunctionSecrets).mockResolvedValue()
  })

  it('returns only project-scoped write-only metadata', async () => {
    vi.mocked(listFunctionSecretMetadata).mockResolvedValue([
      { name: 'TOKEN', value: 'a'.repeat(64), updated_at: '2026-07-17T00:00:00.000Z' },
    ])
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req, res, claims)
    expect(guardProjectRoute).toHaveBeenCalledWith(
      res,
      claims,
      expect.objectContaining({
        action: PermissionAction.FUNCTIONS_SECRET_READ,
        projectRef: 'project-a',
      })
    )
    expect(res._getJSONData()).toEqual([
      { name: 'TOKEN', value: 'a'.repeat(64), updated_at: '2026-07-17T00:00:00.000Z' },
    ])
    expect(res.getHeader('Cache-Control')).toBe('no-store')
  })

  it('validates and stores secrets without returning values', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'project-a' },
      body: [{ name: 'TOKEN', value: 'write-only-value' }],
      headers: { 'x-correlation-id': 'request-a' },
    })
    await handler(req, res, claims)
    expect(guardProjectRoute).toHaveBeenCalledWith(
      res,
      claims,
      expect.objectContaining({ action: PermissionAction.SECRETS_WRITE })
    )
    expect(upsertFunctionSecrets).toHaveBeenCalledWith({
      projectRef: 'project-a',
      secrets: [{ name: 'TOKEN', value: 'write-only-value' }],
      actor: 'operator-a',
      correlationId: 'request-a',
    })
    expect(res._getJSONData()).toEqual({ message: 'Secrets stored' })
  })

  it('deletes named secrets and stops before storage when access is denied', async () => {
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { ref: 'project-a' },
      body: ['TOKEN'],
    })
    await handler(req, res, claims)
    expect(deleteFunctionSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'project-a', names: ['TOKEN'], actor: 'operator-a' })
    )

    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const denied = createMocks({ method: 'POST', query: { ref: 'project-b' }, body: [] })
    await handler(denied.req, denied.res, claims)
    expect(upsertFunctionSecrets).not.toHaveBeenCalled()
  })
})
