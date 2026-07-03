import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => {
  const original = await importOriginal<object>()
  return {
    ...original,
    resolveProjectConnection,
  }
})

afterEach(() => vi.unstubAllEnvs())

describe('config (plain self-hosted, zero-break)', () => {
  it('returns global env jwt_secret; resolver untouched', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
    vi.stubEnv('AUTH_JWT_SECRET', 'env-secret')
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().jwt_secret).toBe('env-secret')
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
