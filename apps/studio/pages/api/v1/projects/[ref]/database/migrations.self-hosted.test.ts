// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). migrations.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so this
// sibling covers the off-branch with a fresh module load (see
// projects/[ref]/run-lints.self-hosted.test.ts for the pattern).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const listMigrationVersions = vi.fn()
const applyAndTrackMigrations = vi.fn()
vi.mock('@/lib/api/self-hosted/migrations', () => ({
  listMigrationVersions,
  applyAndTrackMigrations,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  listMigrationVersions.mockReset()
  applyAndTrackMigrations.mockReset()
})

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./migrations')).handler
}

describe('GET /v1/projects/[ref]/database/migrations (plain self-hosted, zero-break)', () => {
  it('calls listMigrationVersions without a projectRef when self-platform is off', async () => {
    const handler = await loadHandler('')
    listMigrationVersions.mockResolvedValueOnce({ data: [], error: undefined })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(listMigrationVersions.mock.calls[0][0].projectRef).toBeUndefined()
    expect(res._getStatusCode()).toBe(200)
  })
})

describe('POST /v1/projects/[ref]/database/migrations (plain self-hosted, zero-break)', () => {
  it('calls applyAndTrackMigrations without a projectRef when self-platform is off', async () => {
    const handler = await loadHandler('')
    applyAndTrackMigrations.mockResolvedValueOnce({ data: [], error: undefined })
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'default' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)
    expect(applyAndTrackMigrations.mock.calls[0][0].projectRef).toBeUndefined()
    expect(res._getStatusCode()).toBe(200)
  })

  it('405s a non-GET/POST method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'DELETE', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
