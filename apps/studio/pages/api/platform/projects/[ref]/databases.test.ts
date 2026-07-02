import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

// [self-platform] `handler` branches on IS_SELF_PLATFORM, which is resolved at module load from
// NEXT_PUBLIC_SELF_PLATFORM. Each env combination needs a fresh module instance (same pattern as
// the sibling `index.test.ts` / lib/api/self-hosted/util.test.ts's loadUtil).
async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return await import('./databases')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /platform/projects/{ref}/databases', () => {
  it('returns an empty connectionString in plain self-hosted mode (legacy, byte-identical)', async () => {
    const { handler } = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body[0].connectionString).toBe('')
  })

  it('[self-platform] returns a non-empty, real encrypted connectionString', async () => {
    const { handler } = await loadHandler('true')
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(typeof body[0].connectionString).toBe('string')
    expect(body[0].connectionString).not.toBe('')
    // identifier must still match what the client's database selector defaults to
    expect(body[0].identifier).toBe('default')
  })

  it('rejects non-GET methods with 405', async () => {
    const { handler } = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(405)
  })
})
