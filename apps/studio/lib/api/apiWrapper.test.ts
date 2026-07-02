import { createMocks } from 'node-mocks-http'
import { describe, expect, it } from 'vitest'

import apiWrapper from './apiWrapper'

describe('apiWrapper error catchall', () => {
  it('returns 500 when a sync handler throws', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await apiWrapper(req as any, res as any, () => {
      throw new Error('sync boom')
    })
    expect(res._getStatusCode()).toBe(500)
  })

  it('returns 500 when an async handler rejects', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await apiWrapper(req as any, res as any, async () => {
      throw new Error('async boom')
    })
    expect(res._getStatusCode()).toBe(500)
  })
})
