import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => {
  const original = await importOriginal<object>()
  return {
    ...original,
    resolveProjectConnection,
  }
})

beforeEach(() => resolveProjectConnection.mockReset())

describe('GET /platform/projects/{ref}/config (self-platform)', () => {
  it('returns the resolved project jwt_secret, keeping non-secret fields', async () => {
    resolveProjectConnection.mockResolvedValueOnce({ row: { id: 2 }, jwtSecret: 'secret-b' })
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body.jwt_secret).toBe('secret-b')
    expect(body.db_anon_role).toBe('anon')
    expect(body.db_schema).toBe('public, storage')
    expect(body.max_rows).toBe(100)
  })

  it('404s unknown ref', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    resolveProjectConnection.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { handler } = await import('./index')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })
})
