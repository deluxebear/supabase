import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './config'
import { readAuthConfig, writeAuthConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/auth-config', () => ({
  readAuthConfig: vi.fn(),
  writeAuthConfig: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(readAuthConfig)
    .mockReset()
    .mockResolvedValue({ DISABLE_SIGNUP: false } as never)
  vi.mocked(writeAuthConfig)
    .mockReset()
    .mockResolvedValue({ DISABLE_SIGNUP: true } as never)
})

describe('GET/PATCH /platform/auth/[ref]/config (self-platform)', () => {
  it('GET is read-gated on custom_config_gotrue and returns the config', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'read:Read',
      projectRef: 'default',
      resource: 'custom_config_gotrue',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ DISABLE_SIGNUP: false })
    expect(readAuthConfig).toHaveBeenCalledWith('default')
  })

  it('GET denied → guard short-circuits, data layer untouched', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, claimsOf('g-dev'))
    expect(readAuthConfig).not.toHaveBeenCalled()
  })

  it('PATCH is write-gated (UPDATE) and threads body + updated_by', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'default' },
      body: { DISABLE_SIGNUP: true },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Update',
      resource: 'custom_config_gotrue',
    })
    expect(writeAuthConfig).toHaveBeenCalledWith('default', { DISABLE_SIGNUP: true }, 'g-owner')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ DISABLE_SIGNUP: true })
  })

  it('405 for unsupported method; 400 for array ref', async () => {
    const put = createMocks({ method: 'PUT', query: { ref: 'default' } })
    await handler(put.req as never, put.res as never, claimsOf('g-1'))
    expect(put.res._getStatusCode()).toBe(405)
    const arr = createMocks({ method: 'GET', query: { ref: ['a', 'b'] } })
    await handler(arr.req as never, arr.res as never, claimsOf('g-1'))
    expect(arr.res._getStatusCode()).toBe(400)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })
})
