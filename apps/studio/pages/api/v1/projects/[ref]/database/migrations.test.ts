import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './migrations'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

// [self-platform] vi.hoisted() avoids the vi.mock factory TDZ (see
// run-lints.test.ts / Task 6/7 precedent).
const { listMigrationVersions, applyAndTrackMigrations } = vi.hoisted(() => ({
  listMigrationVersions: vi.fn(),
  applyAndTrackMigrations: vi.fn(),
}))
vi.mock('@/lib/api/self-hosted/migrations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listMigrationVersions,
  applyAndTrackMigrations,
}))

beforeEach(() => {
  listMigrationVersions.mockReset()
  applyAndTrackMigrations.mockReset()
})

describe('GET /v1/projects/{ref}/database/migrations (self-platform)', () => {
  it('threads the ref (and headers) into listMigrationVersions', async () => {
    listMigrationVersions.mockResolvedValueOnce({ data: [], error: undefined })
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(listMigrationVersions).toHaveBeenCalledWith({
      headers: expect.anything(),
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(200)
  })

  it('404s unknown ref', async () => {
    listMigrationVersions.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })
})

describe('POST /v1/projects/{ref}/database/migrations (self-platform)', () => {
  it('threads the ref into applyAndTrackMigrations', async () => {
    applyAndTrackMigrations.mockResolvedValueOnce({ data: [], error: undefined })
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'proj-b' },
      body: { query: 'select 1', name: 'my migration' },
    })
    await handler(req as any, res as any)
    expect(applyAndTrackMigrations.mock.calls[0][0].projectRef).toBe('proj-b')
    expect(res._getStatusCode()).toBe(200)
  })

  it('404s unknown ref', async () => {
    applyAndTrackMigrations.mockRejectedValueOnce(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({
      method: 'POST',
      query: { ref: 'ghost' },
      body: { query: 'select 1' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })
})
