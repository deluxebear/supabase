import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

afterEach(() => vi.unstubAllEnvs())

describe('temporary api-key (plain self-hosted, zero-break)', () => {
  it('returns the global service key byte-identically; resolver untouched', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service-key')
    const { handler } = await import('./temporary')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ api_key: 'global-service-key' })
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
