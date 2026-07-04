import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (
    await import('@/pages/api/platform/organizations/[slug]/members/invitations/[id_or_token]')
  ).handler
}

afterEach(() => vi.unstubAllEnvs())

describe('invitation item route — plain self-hosted (zero-break)', () => {
  it.each(['GET', 'POST', 'DELETE'])('%s returns the full 404 body unchanged', async (method) => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({
      method: method as any,
      query: { slug: 'default', id_or_token: '1' },
    })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
