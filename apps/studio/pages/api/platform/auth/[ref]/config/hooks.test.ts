import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './hooks'
import { writeHookConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/auth-config', () => ({ writeHookConfig: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(writeHookConfig)
    .mockReset()
    .mockResolvedValue({ DISABLE_SIGNUP: false } as never)
})

describe('PATCH /platform/auth/[ref]/config/hooks (self-platform)', () => {
  it('is write-gated (UPDATE custom_config_gotrue) and persists the hook body', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'default' },
      body: { HOOK_SEND_EMAIL_ENABLED: true },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Update',
      resource: 'custom_config_gotrue',
    })
    expect(writeHookConfig).toHaveBeenCalledWith(
      'default',
      { HOOK_SEND_EMAIL_ENABLED: true },
      'g-owner'
    )
    expect(res._getStatusCode()).toBe(200)
  })

  it('405 for GET (hooks is PATCH-only)', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })
})
