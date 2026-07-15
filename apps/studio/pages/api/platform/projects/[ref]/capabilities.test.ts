import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './capabilities'
import { listProjectCapabilities } from '@/lib/api/self-platform/attachment'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/attachment', () => ({ listProjectCapabilities: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const claims = { sub: 'user-a' } as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(listProjectCapabilities)
    .mockReset()
    .mockResolvedValue([
      {
        name: 'project.detach',
        state: 'available',
        mode: 'direct',
        source: 'preflight',
        contractVersion: 'v1',
        targetVersion: null,
        observationRevision: 'r1',
        observedAt: '2026-07-15T00:00:00.000Z',
        validUntil: null,
        blockers: [],
      },
    ])
})

describe('GET /platform/projects/[ref]/capabilities', () => {
  it('checks project-scoped RBAC before reading the capability projection', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req as never, res as never, claims)

    expect(guardProjectRoute).toHaveBeenCalledWith(
      res,
      claims,
      expect.objectContaining({
        action: 'read:Read',
        resource: 'projects',
        projectRef: 'project-a',
      })
    )
    expect(listProjectCapabilities).toHaveBeenCalledWith('project-a')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().capabilities[0]).toMatchObject({
      name: 'project.detach',
      blockers: [],
    })
  })

  it('does not read another project after RBAC denial', async () => {
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ code: 'forbidden', message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-b' } })
    await handler(req as never, res as never, claims)

    expect(res._getStatusCode()).toBe(403)
    expect(listProjectCapabilities).not.toHaveBeenCalled()
  })

  it('rejects malformed refs and unsupported methods before data access', async () => {
    const malformed = createMocks({ method: 'GET', query: { ref: ['a', 'b'] } })
    await handler(malformed.req as never, malformed.res as never, claims)
    expect(malformed.res._getStatusCode()).toBe(400)

    const unsupported = createMocks({ method: 'POST', query: { ref: 'project-a' } })
    await handler(unsupported.req as never, unsupported.res as never, claims)
    expect(unsupported.res._getStatusCode()).toBe(405)
    expect(listProjectCapabilities).not.toHaveBeenCalled()
  })
})
