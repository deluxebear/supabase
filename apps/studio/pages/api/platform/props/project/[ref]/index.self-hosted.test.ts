// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). index.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so this sibling
// covers the off-branch with a fresh module load per Task 6's pattern (see
// pages/api/platform/projects/[ref]/index.self-hosted.test.ts).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  resolveProjectConnection.mockReset()
})

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://localhost:8000')
  return (await import('./index')).handler
}

describe('GET /platform/props/project/{ref} (plain self-hosted, zero-break)', () => {
  it('returns the historical global literal, byte-identical, when self-platform is off', async () => {
    const handler = await loadHandler('')

    const { DEFAULT_PROJECT } = await import('@/lib/constants/api')

    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({
      project: {
        ...DEFAULT_PROJECT,
        services: [],
      },
    })
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
