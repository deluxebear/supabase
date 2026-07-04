import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './config'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = ''
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

describe('config zero-break (plain self-hosted)', () => {
  it.each(['GET', 'PATCH', 'PUT'])('%s → byte-identical 404', async (method) => {
    const { req, res } = createMocks({ method: method as never, query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
