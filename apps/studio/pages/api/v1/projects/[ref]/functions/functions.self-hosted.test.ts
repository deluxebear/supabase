import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const { getFunctions } = vi.hoisted(() => ({ getFunctions: vi.fn() }))
vi.mock('@/lib/api/self-hosted/functions', () => ({
  getFunctionsArtifactStore: () => ({ getFunctions }),
}))

afterEach(() => vi.unstubAllEnvs())

describe('v1 functions — plain self-hosted (zero-break)', () => {
  it('GET works without any guard call and returns the store mapping', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    getFunctions.mockResolvedValue([])
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([])
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })
})
