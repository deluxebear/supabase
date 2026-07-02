// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). The main projects.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so
// this sibling covers the off-branch with a fresh module load per Task 6's
// pattern (see [ref]/index.self-hosted.test.ts).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./projects')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/organizations/{slug}/projects (plain self-hosted, zero-break)', () => {
  it('returns 404 not-available when self-platform is off', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
