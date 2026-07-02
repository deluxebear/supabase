// [self-platform] Deferred finding 8 — this route's ProjectNotFound -> 404
// mapping was untested. Self-platform on + an unknown ref must map to
// `404 {message:'Project not found'}`, consistent with Task 6/7's
// resolveProjectConnection error handling used by the sibling routes.
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn() }
})

beforeEach(() => vi.clearAllMocks())

describe('POST /platform/pg-meta/[ref]/query (self-platform)', () => {
  it('returns 404 Project not found when resolveProjectConnection throws ProjectNotFound', async () => {
    const { ProjectNotFound } = await import('@/lib/api/self-platform/resolve-connection')
    vi.mocked(resolveProjectConnection).mockRejectedValue(new ProjectNotFound('ghost'))

    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'ghost' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('executes against the resolved project connection when the project is registered', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      pgConnEncrypted: 'ENC-B',
      pgConnReadOnlyEncrypted: 'ENC-B-RO',
    } as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ok: true }]), { status: 200 }))
    )

    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    const init = (globalThis.fetch as any).mock.calls[0][1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe('ENC-B')

    vi.unstubAllGlobals()
  })
})
