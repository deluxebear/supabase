import type { NextApiRequest, NextApiResponse } from 'next'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './jwt'

const backend = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  return { guard: vi.fn(), apply: vi.fn(), status: vi.fn() }
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: backend.guard }))
vi.mock('@/lib/api/self-platform/jwt-configuration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/jwt-configuration')>()),
  applyJWTConfiguration: backend.apply,
  getJWTConfigurationStatus: backend.status,
}))

beforeEach(() => {
  backend.guard.mockReset().mockResolvedValue(true)
  backend.apply.mockReset().mockResolvedValue({ id: 'operation-a' })
  backend.status.mockReset().mockResolvedValue({ observedAt: 'now' })
})
const input = {
  secret: 's'.repeat(32),
  expectedGeneration: 0,
  confirmOwnership: true,
  confirmTokenInvalidation: true,
}
const claims = {
  sub: 'admin',
  aal: 'aal2' as const,
  iat: Math.floor(Date.now() / 1000),
  iss: 'test',
  aud: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600,
  role: 'authenticated',
  session_id: 'test-session',
}

describe('Fleet JWT configuration API', () => {
  it('requires permissions before reading or changing configuration', async () => {
    backend.guard.mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'POST',
      query: { ref: 'project-a' },
      body: input,
    })
    await handler(req, res, claims)
    expect(res._getStatusCode()).toBe(403)
    expect(backend.apply).not.toHaveBeenCalled()
    expect(backend.status).not.toHaveBeenCalled()
  })
  it('requires recent AAL2 before coordinating service restarts', async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'POST',
      query: { ref: 'project-a' },
      headers: { 'idempotency-key': 'key' },
      body: input,
    })
    await handler(req, res, { ...claims, aal: 'aal1' })
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual(expect.objectContaining({ code: 'aal2_required' }))
    expect(backend.apply).not.toHaveBeenCalled()
  })
  it('rejects missing invalidation confirmation', async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'POST',
      query: { ref: 'project-a' },
      headers: { 'idempotency-key': 'key' },
      body: { ...input, confirmTokenInvalidation: false },
    })
    await handler(req, res, claims)
    expect(res._getStatusCode()).toBe(400)
    expect(backend.apply).not.toHaveBeenCalled()
  })
  it('queues the configuration for the authorized project without echoing secrets', async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'POST',
      query: { ref: 'project-a' },
      headers: { 'idempotency-key': 'key' },
      body: input,
    })
    await handler(req, res, claims)
    expect(res._getStatusCode()).toBe(202)
    expect(backend.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: 'project-a',
        actor: 'admin',
        secret: input.secret,
        idempotencyKey: 'key',
      })
    )
    expect(JSON.stringify(res._getJSONData())).not.toContain(input.secret)
    expect(res.getHeader('Cache-Control')).toBe('no-store')
  })
})
