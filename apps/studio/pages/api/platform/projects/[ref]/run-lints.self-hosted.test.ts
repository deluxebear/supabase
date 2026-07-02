// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). run-lints.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so this
// sibling covers the off-branch with a fresh module load (see
// projects/[ref]/databases.self-hosted.test.ts for the pattern).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getLints = vi.fn()
vi.mock('@/lib/api/self-hosted/lints', () => ({ getLints }))

afterEach(() => {
  vi.unstubAllEnvs()
  getLints.mockReset()
})

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./run-lints')).handler
}

describe('GET /platform/projects/[ref]/run-lints (plain self-hosted, zero-break)', () => {
  it('calls getLints without a projectRef when self-platform is off', async () => {
    const handler = await loadHandler('')
    getLints.mockResolvedValueOnce({ data: [], error: undefined })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(getLints.mock.calls[0][0].projectRef).toBeUndefined()
    expect(res._getStatusCode()).toBe(200)
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
