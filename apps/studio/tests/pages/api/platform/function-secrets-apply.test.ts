import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServiceConfigApplyConflict } from '@/lib/api/self-platform/service-config-apply'
import {
  applyFunctionSecrets,
  getFunctionSecretsApplyStatus,
} from '@/lib/api/self-platform/function-secrets-apply'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { handler } from '@/pages/api/platform/projects/[ref]/functions/secrets/apply'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/function-secrets-apply', () => ({
  applyFunctionSecrets: vi.fn(),
  getFunctionSecretsApplyStatus: vi.fn(),
}))

const now = Math.floor(Date.now() / 1000)
const aal2 = { sub: 'user-1', aal: 'aal2', iat: now } as JwtPayload

function post(body: unknown, headers: Record<string, string> = { 'idempotency-key': 'key-1' }) {
  return createMocks({ method: 'POST', query: { ref: 'project-a' }, body: body as never, headers })
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(getFunctionSecretsApplyStatus).mockReset()
  vi.mocked(applyFunctionSecrets).mockReset()
})

describe('/platform/projects/[ref]/functions/secrets/apply', () => {
  it('GET needs secret read permission and returns the status uncached', async () => {
    vi.mocked(getFunctionSecretsApplyStatus).mockResolvedValue({ state: 'pending' } as never)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-a' } })
    await handler(req as never, res as never, aal2)
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'functions:Secret:Read',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res.getHeader('Cache-Control')).toBe('no-store')
    expect(vi.mocked(getFunctionSecretsApplyStatus).mock.calls[0]).toEqual([
      'project-a',
      { actor: 'user-1', correlationId: expect.any(String) },
    ])
  })

  it('POST needs secret write permission, an idempotency key, and a recent AAL2 session', async () => {
    const noKey = post({ expectedGeneration: 0 }, {})
    await handler(noKey.req as never, noKey.res as never, aal2)
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'secrets:Write',
    })
    expect(noKey.res._getStatusCode()).toBe(400)

    const stale = post({ expectedGeneration: 0 })
    await handler(
      stale.req as never,
      stale.res as never,
      { ...aal2, iat: now - 3600 } as JwtPayload
    )
    expect(stale.res._getStatusCode()).toBe(403)
    expect(stale.res._getJSONData().code).toBe('aal2_required')
    expect(applyFunctionSecrets).not.toHaveBeenCalled()
  })

  it('POST commits the apply and maps conflicts to 409', async () => {
    vi.mocked(applyFunctionSecrets).mockResolvedValue({ operationId: 'op' } as never)
    const ok = post({ expectedGeneration: 4, confirmOwnership: true })
    await handler(ok.req as never, ok.res as never, aal2)
    expect(ok.res._getStatusCode()).toBe(202)
    expect(vi.mocked(applyFunctionSecrets).mock.calls[0][0]).toMatchObject({
      projectRef: 'project-a',
      expectedGeneration: 4,
      confirmOwnership: true,
      idempotencyKey: 'key-1',
      actor: 'user-1',
    })

    vi.mocked(applyFunctionSecrets).mockRejectedValue(
      new ServiceConfigApplyConflict('secrets_too_large', 'Too large')
    )
    const conflict = post({ expectedGeneration: 4 })
    await handler(conflict.req as never, conflict.res as never, aal2)
    expect(conflict.res._getStatusCode()).toBe(409)
    expect(conflict.res._getJSONData().code).toBe('secrets_too_large')
  })
})
