import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './sso'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

describe('GET /platform/organizations/{slug}/sso (self-platform stub)', () => {
  it('returns the graceful-degradation 404 the frontend special-cases', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(404)
    // sso-config-query.ts 以该 message 子串 + code 404 判定"未配置 SSO"并返回 null
    expect(res._getJSONData()).toEqual({
      message: 'Failed to find an existing SSO Provider for this organization',
    })
  })

  it('405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
  })
})
