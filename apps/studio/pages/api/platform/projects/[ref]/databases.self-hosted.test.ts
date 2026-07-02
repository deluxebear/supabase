import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./databases')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/projects/[ref]/databases (plain self-hosted, zero-break)', () => {
  it('returns one default database entry with empty conn strings when self-platform is off', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body[0].connectionString).toBe('')
    expect(body[0].connection_string_read_only).toBe('')
    expect(body[0].identifier).toBe('default')
    expect(body[0].cloud_provider).toBe('AWS')
  })
  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
