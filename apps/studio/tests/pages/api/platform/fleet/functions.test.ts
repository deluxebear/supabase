import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  deleteFunction,
  deployFunction,
  listFunctionDeployments,
} from '@/lib/api/self-platform/function-deployments'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler } from '@/pages/api/platform/fleet/v1/projects/[ref]/functions'

vi.mock('@/lib/api/self-platform/attachment', () => ({ requireProjectCapability: vi.fn() }))
vi.mock('@/lib/api/self-platform/function-deployments', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/api/self-platform/function-deployments')>()
  return {
    ...original,
    deployFunction: vi.fn(),
    deleteFunction: vi.fn(),
    listFunctionDeployments: vi.fn(),
  }
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { remoteFunctionsDeployment: true },
}))

describe('Fleet Edge Functions API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(requireProjectCapability).mockResolvedValue({} as never)
  })

  it('applies RBAC and capability checks before an exact-project list', async () => {
    vi.mocked(listFunctionDeployments).mockResolvedValue([])
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    const claims = { sub: 'user-a' } as JwtPayload
    await handler(req, res, claims)
    expect(guardProjectRoute).toHaveBeenCalledWith(res, claims, {
      action: expect.any(String),
      projectRef: 'project-a',
    })
    expect(requireProjectCapability).toHaveBeenCalledWith('project-a', 'functions.read')
    expect(listFunctionDeployments).toHaveBeenCalledWith('project-a')
    expect(res._getStatusCode()).toBe(200)
  })

  it('does not enumerate or execute after RBAC denial', async () => {
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(404).json({ code: 'project_not_found' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-b' } })
    await handler(req, res, { sub: 'user-a' } as JwtPayload)
    expect(res._getStatusCode()).toBe(404)
    expect(requireProjectCapability).not.toHaveBeenCalled()
    expect(listFunctionDeployments).not.toHaveBeenCalled()
  })

  it('passes only validated project deployment input and idempotency identity', async () => {
    vi.mocked(deployFunction).mockResolvedValue({ slug: 'hello' } as never)
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'project-a' },
      headers: { 'idempotency-key': 'idem-a', 'x-correlation-id': 'request-a' },
      body: {
        slug: 'hello',
        expectedGeneration: 0,
        metadata: { entrypointPath: 'index.ts', staticPatterns: [], verifyJwt: true },
        files: [{ name: 'index.ts', content: 'export default 1' }],
      },
    })
    await handler(req, res, { sub: 'user-a' } as JwtPayload)
    expect(deployFunction).toHaveBeenCalledWith({
      projectRef: 'project-a',
      actor: 'user-a',
      correlationId: 'request-a',
      value: expect.objectContaining({ slug: 'hello', idempotencyKey: 'idem-a' }),
    })
    expect(res._getStatusCode()).toBe(202)
  })

  it('rejects unknown fields before deployment', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'project-a' },
      headers: { 'idempotency-key': 'idem-a' },
      body: {
        slug: 'hello',
        expectedGeneration: 0,
        metadata: { entrypointPath: 'index.ts', staticPatterns: [], verifyJwt: true },
        files: [{ name: 'index.ts', content: 'safe', symlink: '../../secret' }],
      },
    })
    await handler(req, res, { sub: 'user-a' } as JwtPayload)
    expect(res._getStatusCode()).toBe(400)
    expect(deployFunction).not.toHaveBeenCalled()
  })

  it('requires idempotency for destructive deletion', async () => {
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { ref: 'project-a' },
      body: { slug: 'hello', expectedGeneration: 1 },
    })
    await handler(req, res, { sub: 'user-a' } as JwtPayload)
    expect(res._getStatusCode()).toBe(400)
    expect(deleteFunction).not.toHaveBeenCalled()
  })
})
