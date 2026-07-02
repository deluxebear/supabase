import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './temporary'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] This file also does a plain top-level `import { ProjectNotFound }`
// from this same module path (above), which forces Vitest to eagerly resolve
// the mocked module before a plain `const resolveProjectConnection = vi.fn()`
// would have initialized — vi.hoisted() avoids that TDZ (see Task 6/7 precedent).
const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

function decodePayload(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

beforeEach(() => resolveProjectConnection.mockReset())

describe('POST /platform/projects/{ref}/api-keys/temporary (self-platform)', () => {
  it('mints a short-lived JWT with the resolved project secret', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    const { req, res } = createMocks({
      method: 'POST',
      query: {
        ref: 'proj-b',
        authorization_exp: '300',
        claims: JSON.stringify({ role: 'service_role' }),
      },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const { api_key } = res._getJSONData()
    expect(api_key).not.toBe('secret-b')
    const payload = decodePayload(api_key)
    expect(payload.role).toBe('service_role')
    expect(payload.exp - payload.iat).toBe(300)
  })

  it('clamps exp to 3600 and defaults to 300', async () => {
    resolveProjectConnection.mockResolvedValue({ row: { id: 2 }, jwtSecret: 's' })
    const { req: r1, res: s1 } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b', authorization_exp: '999999' },
    })
    await handler(r1 as any, s1 as any)
    const p1 = decodePayload(s1._getJSONData().api_key)
    expect(p1.exp - p1.iat).toBe(3600)
    const { req: r2, res: s2 } = createMocks({ method: 'POST', query: { ref: 'proj-b' } })
    await handler(r2 as any, s2 as any)
    const p2 = decodePayload(s2._getJSONData().api_key)
    expect(p2.exp - p2.iat).toBe(300)
  })

  it('400s a non-allowlisted role and malformed inputs', async () => {
    resolveProjectConnection.mockResolvedValue({ row: { id: 2 }, jwtSecret: 's' })
    for (const query of [
      { ref: 'proj-b', claims: JSON.stringify({ role: 'postgres' }) },
      { ref: 'proj-b', claims: 'not-json' },
      { ref: 'proj-b', authorization_exp: 'NaN' },
    ]) {
      const { req, res } = createMocks({ method: 'POST', query })
      await handler(req as any, res as any)
      expect(res._getStatusCode()).toBe(400)
    }
  })

  it('404s unknown ref; 500s (fail closed) on empty jwt secret', async () => {
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req: r1, res: s1 } = createMocks({ method: 'POST', query: { ref: 'ghost' } })
    await handler(r1 as any, s1 as any)
    expect(s1._getStatusCode()).toBe(404)

    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: '' })
    const { req: r2, res: s2 } = createMocks({ method: 'POST', query: { ref: 'proj-b' } })
    await handler(r2 as any, s2 as any)
    expect(s2._getStatusCode()).toBe(500)
    expect(s2._getJSONData().api_key).toBeUndefined()
  })
})
