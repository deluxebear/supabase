import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './projects-resource-warnings'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'false'
})

describe('GET projects-resource-warnings (plain — M1 stub byte-identical)', () => {
  it('returns []', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([])
  })
})
