import { createMocks } from 'node-mocks-http'
import { describe, expect, it } from 'vitest'

import apiWrapper from './apiWrapper'
import { ProjectNotFound } from './self-platform/resolve-connection'

describe('apiWrapper ProjectNotFound mapping', () => {
  it('maps ProjectNotFound to 404 { message }', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await apiWrapper(
      req as any,
      res as any,
      async () => {
        throw new ProjectNotFound('ghost')
      },
      { withAuth: false }
    )
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('keeps generic errors on the 500 catchall', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await apiWrapper(
      req as any,
      res as any,
      async () => {
        throw new Error('boom')
      },
      { withAuth: false }
    )
    expect(res._getStatusCode()).toBe(500)
  })
})
