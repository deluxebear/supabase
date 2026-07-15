import { describe, expect, it, vi } from 'vitest'

import route from './index'

vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'embedded',
  STUDIO_CAPABILITIES: { lifecycleManagement: false },
}))

describe('Embedded lifecycle API isolation', () => {
  it('keeps the Fleet lifecycle route unavailable', () => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.body = body
        return this
      },
    }
    route({} as never, res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ code: 'project_not_found', message: 'Not found' })
  })
})
