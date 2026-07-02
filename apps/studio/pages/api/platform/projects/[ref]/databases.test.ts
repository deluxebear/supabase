import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './databases'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn() }
})

const resolved = {
  ref: 'proj-b',
  pgConnEncrypted: 'ENC',
  pgConnReadOnlyEncrypted: 'ENC_RO',
  dbHost: 'db-b',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  restUrl: 'http://kong-b:8000/rest/v1/',
  region: 'local',
  status: 'ACTIVE_HEALTHY',
  cloudProvider: 'AWS',
}
beforeEach(() => vi.clearAllMocks())

describe('GET /platform/projects/[ref]/databases (self-platform)', () => {
  it('returns one database entry with both encrypted conn strings', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body[0]).toMatchObject({
      identifier: 'proj-b',
      connectionString: 'ENC',
      connection_string_read_only: 'ENC_RO',
      db_host: 'db-b',
      db_port: 5432,
      status: 'ACTIVE_HEALTHY',
    })
  })
})
