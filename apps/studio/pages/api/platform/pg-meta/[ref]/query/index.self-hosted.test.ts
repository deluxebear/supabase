// [self-platform] IMPORTANT 5 — zero-break coverage for plain self-hosted
// (self-platform off). This route has no explicit `!IS_SELF_PLATFORM`
// early-return itself — the gate lives downstream in
// lib/api/self-hosted/query.ts's executeQuery (only resolves a per-project
// connection when `IS_SELF_PLATFORM && projectRef`) — so this asserts the
// observable global-path result: the global-env connection is used and
// resolveProjectConnection is never called.
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn() }
})

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./index')).handler
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ok: true }]), { status: 200 }))
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /platform/pg-meta/[ref]/query (plain self-hosted, zero-break)', () => {
  it('executes against the global-env connection and never resolves a per-project connection', async () => {
    const handler = await loadHandler('')
    const { resolveProjectConnection } = await import('@/lib/api/self-platform/resolve-connection')

    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'default' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual([{ ok: true }])
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })

  it('405s a non-POST method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
