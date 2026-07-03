import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './entitlements'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

describe('GET /platform/organizations/{slug}/entitlements (self-platform, M3.1)', () => {
  it('lights up project_scoped_roles and security.enforce_mfa', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({
      entitlements: [
        {
          config: { enabled: true },
          feature: { key: 'project_scoped_roles', type: 'boolean' },
          hasAccess: true,
          type: 'boolean',
        },
        {
          config: { enabled: true },
          feature: { key: 'security.enforce_mfa', type: 'boolean' },
          hasAccess: true,
          type: 'boolean',
        },
      ],
    })
  })
})
