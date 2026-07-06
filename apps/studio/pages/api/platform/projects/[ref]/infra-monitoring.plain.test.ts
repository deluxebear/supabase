import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './infra-monitoring'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'false'
})

describe('GET infra-monitoring (plain self-hosted — M1 stub byte-identical)', () => {
  it('returns the M1 literal with no auth and no claims', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ data: [], yAxisLimit: 0, format: '%', total: 0 })
  })
})
