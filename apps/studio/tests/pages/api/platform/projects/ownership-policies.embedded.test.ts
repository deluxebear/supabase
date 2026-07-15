import { describe, expect, it, vi } from 'vitest'

import route from '@/pages/api/platform/projects/[ref]/ownership-policies'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'embedded'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'false'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'false'
})

describe('Embedded ownership reconciliation isolation', () => {
  it('returns 404 before authentication or platform-store access', () => {
    const response = {
      statusCode: 200,
      payload: undefined as unknown,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(value: unknown) {
        this.payload = value
        return this
      },
    }
    route({ method: 'GET', query: { ref: 'default' } } as never, response as never)
    expect(response.statusCode).toBe(404)
    expect(response.payload).toEqual({ code: 'project_not_found', message: 'Not found' })
  })
})
