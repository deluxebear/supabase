import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyAuthConfig,
  AuthApplyConflict,
  getAuthApplyStatus,
} from '@/lib/api/self-platform/auth-apply'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler, hasRecentAal2 } from '@/pages/api/platform/auth/[ref]/config/apply'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/auth-apply', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/self-platform/auth-apply')>(
    '@/lib/api/self-platform/auth-apply'
  )
  return { ...actual, applyAuthConfig: vi.fn(), getAuthApplyStatus: vi.fn() }
})

const now = Math.floor(Date.now() / 1000)
const aal2 = { sub: 'user-1', aal: 'aal2', iat: now } as JwtPayload

function post(body: unknown, headers: Record<string, string> = { 'idempotency-key': 'key-1' }) {
  return createMocks({ method: 'POST', query: { ref: 'project-a' }, body: body as never, headers })
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(getAuthApplyStatus).mockReset()
  vi.mocked(applyAuthConfig).mockReset()
})

describe('/platform/auth/[ref]/config/apply', () => {
  it('GET is read-gated and returns the apply status', async () => {
    vi.mocked(getAuthApplyStatus).mockResolvedValue({ state: 'pending' } as never)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req as never, res as never, aal2)
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'read:Read',
      resource: 'custom_config_gotrue',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ state: 'pending' })
    expect(vi.mocked(getAuthApplyStatus).mock.calls[0]).toEqual([
      'project-a',
      { actor: 'user-1', correlationId: expect.any(String) },
    ])
  })

  it('POST requires update permission, an idempotency key, and a recent AAL2 session', async () => {
    const denied = post({ expectedGeneration: 0 })
    vi.mocked(guardProjectRoute).mockResolvedValueOnce(false)
    await handler(denied.req as never, denied.res as never, aal2)
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({ action: 'write:Update' })
    expect(applyAuthConfig).not.toHaveBeenCalled()

    const noKey = post({ expectedGeneration: 0 }, {})
    await handler(noKey.req as never, noKey.res as never, aal2)
    expect(noKey.res._getStatusCode()).toBe(400)

    const aal1 = post({ expectedGeneration: 0 })
    await handler(
      aal1.req as never,
      aal1.res as never,
      { sub: 'user-1', aal: 'aal1', iat: now } as JwtPayload
    )
    expect(aal1.res._getStatusCode()).toBe(403)
    expect(aal1.res._getJSONData().code).toBe('aal2_required')

    const stale = post({ expectedGeneration: 0 })
    await handler(
      stale.req as never,
      stale.res as never,
      { ...aal2, iat: now - 3600 } as JwtPayload
    )
    expect(stale.res._getStatusCode()).toBe(403)
    expect(applyAuthConfig).not.toHaveBeenCalled()
  })

  it('POST commits the apply with the explicit ownership confirmation', async () => {
    vi.mocked(applyAuthConfig).mockResolvedValue({ operationId: 'auth_apply_1' } as never)
    const { req, res } = post({ expectedGeneration: 3, confirmOwnership: true })
    await handler(req as never, res as never, aal2)
    expect(res._getStatusCode()).toBe(202)
    expect(vi.mocked(applyAuthConfig).mock.calls[0][0]).toMatchObject({
      projectRef: 'project-a',
      expectedGeneration: 3,
      confirmOwnership: true,
      idempotencyKey: 'key-1',
      actor: 'user-1',
      aal: 'aal2',
    })
  })

  it('POST maps apply conflicts to 409 with their code', async () => {
    vi.mocked(applyAuthConfig).mockRejectedValue(
      new AuthApplyConflict('ownership_confirmation_required', 'Confirm ownership')
    )
    const { req, res } = post({ expectedGeneration: 0 })
    await handler(req as never, res as never, aal2)
    expect(res._getStatusCode()).toBe(409)
    expect(res._getJSONData().code).toBe('ownership_confirmation_required')
  })

  it('POST rejects unknown body fields', async () => {
    const { req, res } = post({ expectedGeneration: 0, document: 'services: {}' })
    await handler(req as never, res as never, aal2)
    expect(res._getStatusCode()).toBe(400)
  })

  it('hasRecentAal2 accepts only recent AAL2 sessions', () => {
    expect(hasRecentAal2({ aal: 'aal2', iat: 1000 } as JwtPayload, 1500)).toBe(true)
    expect(hasRecentAal2({ aal: 'aal2', iat: 1000 } as JwtPayload, 1700)).toBe(false)
    expect(hasRecentAal2({ aal: 'aal1', iat: 1000 } as JwtPayload, 1000)).toBe(false)
    expect(hasRecentAal2(undefined)).toBe(false)
  })
})
