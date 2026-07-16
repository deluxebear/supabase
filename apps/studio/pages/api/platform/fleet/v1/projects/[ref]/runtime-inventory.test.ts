import type { JwtPayload } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './runtime-inventory'

const mocks = vi.hoisted(() => ({ guard: vi.fn(), inventory: vi.fn() }))

vi.mock('@/lib/constants/deployment-profile', () => ({ STUDIO_DEPLOYMENT_PROFILE: 'fleet' }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: mocks.guard }))
vi.mock('@/lib/api/self-platform/runtime-inventory', () => ({
  getRuntimeInventory: mocks.inventory,
}))

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value
    },
  }
}

function request(method = 'GET') {
  return {
    method,
    query: { ref: 'project-b', refresh: 'true' },
    headers: { 'x-correlation-id': 'correlation-b' },
  } as never
}

describe('Fleet runtime inventory API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.guard.mockResolvedValue(true)
    mocks.inventory.mockResolvedValue({ schema: 'supabase.fleet.runtime.observe.evidence.v1' })
  })

  it('enforces project read access before refreshing the typed Agent inventory', async () => {
    const res = response()
    await handler(request(), res as never, { sub: 'user-b' } as JwtPayload)

    expect(mocks.guard).toHaveBeenCalledWith(
      res,
      expect.anything(),
      expect.objectContaining({ projectRef: 'project-b', resource: 'projects' })
    )
    expect(mocks.inventory).toHaveBeenCalledWith({
      projectRef: 'project-b',
      actor: 'user-b',
      correlationId: 'correlation-b',
      force: true,
    })
    expect(res.statusCode).toBe(200)
  })

  it('does not touch Fleet state when project access is denied', async () => {
    mocks.guard.mockResolvedValue(false)
    const res = response()
    await handler(request(), res as never, { sub: 'user-c' } as JwtPayload)

    expect(mocks.inventory).not.toHaveBeenCalled()
  })

  it('rejects mutation methods', async () => {
    const res = response()
    await handler(request('POST'), res as never, { sub: 'user-b' } as JwtPayload)

    expect(res.statusCode).toBe(405)
    expect(mocks.guard).not.toHaveBeenCalled()
  })
})
