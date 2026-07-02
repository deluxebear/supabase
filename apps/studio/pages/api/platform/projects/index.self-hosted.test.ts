// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). The main index.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so
// this sibling covers the off-branch with a fresh module load per Task 6's
// pattern (see [ref]/index.self-hosted.test.ts).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PROJECT } from '@/lib/constants/api'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./index')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/projects (plain self-hosted, zero-break)', () => {
  it('returns the legacy [DEFAULT_PROJECT] array when self-platform is off, even with the V2 header', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', headers: { version: '2' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([DEFAULT_PROJECT])
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
