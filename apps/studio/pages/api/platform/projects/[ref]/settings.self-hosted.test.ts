// [self-platform] IMPORTANT 5 — zero-break coverage for plain self-hosted
// (self-platform off). Follows the established pattern (see
// [ref]/index.self-hosted.test.ts / databases.self-hosted.test.ts): fresh
// module load per test via dynamic import + vi.resetModules() + vi.stubEnv().
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./settings')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/projects/[ref]/settings (plain self-hosted, zero-break)', () => {
  it('returns the historical global getProjectSettings() shape when self-platform is off', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.ref).toBe('default')
    expect(body.db_ip_addr_config).toBe('legacy')
    expect(body.app_config).toHaveProperty('endpoint')
    expect(body.app_config).toHaveProperty('protocol')
    expect(body.service_api_keys).toHaveLength(2)
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
