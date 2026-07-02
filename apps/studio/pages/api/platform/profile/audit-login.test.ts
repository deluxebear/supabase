import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './audit-login'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

describe('POST /platform/profile/audit-login (self-platform)', () => {
  it('acknowledges the login event with 201 and no body', async () => {
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(201)
    expect(res._getData()).toBe('')
  })

  it('405s a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
