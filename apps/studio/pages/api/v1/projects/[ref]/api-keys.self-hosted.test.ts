// [self-platform] IMPORTANT 5 — zero-break coverage for plain self-hosted
// (self-platform off). Follows the established pattern (see
// platform/projects/[ref]/index.self-hosted.test.ts): fresh module load per
// test via dynamic import + vi.resetModules() + vi.stubEnv().
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  vi.stubEnv('SUPABASE_ANON_KEY', 'global-anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-key')
  return (await import('./api-keys')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /v1/projects/[ref]/api-keys (plain self-hosted, zero-break)', () => {
  it('returns the global-env keys when self-platform is off', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ id: 'anon', api_key: 'global-anon-key' })
    expect(body[1]).toMatchObject({ id: 'service_role', api_key: 'global-service-key' })
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
