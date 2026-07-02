import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './run-lints'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] vi.hoisted() avoids the vi.mock factory TDZ — the mocked
// module is loaded via run-lints.ts's own import chain, which resolves
// before this file's top-level `const` bindings would have initialized
// (see Task 6/7 precedent).
const { getLints } = vi.hoisted(() => ({ getLints: vi.fn() }))
vi.mock('@/lib/api/self-hosted/lints', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLints,
}))

beforeEach(() => getLints.mockReset())

describe('GET /platform/projects/{ref}/run-lints (self-platform)', () => {
  it('threads the ref into getLints', async () => {
    getLints.mockResolvedValueOnce({ data: [], error: undefined })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(getLints.mock.calls[0][0].projectRef).toBe('proj-b')
    expect(res._getStatusCode()).toBe(200)
  })

  it('404s unknown ref', async () => {
    getLints.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })
})
