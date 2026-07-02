import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./index')).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /platform/projects/[ref] (plain self-hosted, zero-break)', () => {
  it('returns the historical stub with empty connectionString when self-platform is off', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.connectionString).toBe('')
    expect(body.ref).toBe('default')
  })
  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
