import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import { getProjectByRef, listAllProjects } from './projects'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
const mockQuery = vi.mocked(executePlatformQuery)

const fullRow = {
  id: 2,
  ref: 'proj-b',
  organization_id: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db',
  db_port: 5432,
  db_name: 'projectb',
  db_user: 'supabase_admin',
  db_user_readonly: 'supabase_read_only_user',
  kong_url: 'http://localhost:8100',
  rest_url: 'http://localhost:8100/rest/v1/',
  db_pass_enc: 'enc',
  service_key_enc: 'enc',
  anon_key_enc: 'enc',
  jwt_secret_enc: 'enc',
  publishable_key_enc: null,
  secret_key_enc: null,
  logflare_url: 'http://localhost:8100/analytics',
  logflare_token_enc: 'enc-token',
}

beforeEach(() => mockQuery.mockReset())

describe('projects.ts analytics columns', () => {
  it('selects logflare columns and returns them on the row', async () => {
    mockQuery.mockResolvedValueOnce({ data: [fullRow], error: undefined })
    const row = await getProjectByRef('proj-b')
    expect(mockQuery.mock.calls[0][0].query).toContain('logflare_url')
    expect(mockQuery.mock.calls[0][0].query).toContain('logflare_token_enc')
    expect(row?.logflare_url).toBe('http://localhost:8100/analytics')
    expect(row?.logflare_token_enc).toBe('enc-token')
  })

  it('retries without analytics columns on a pre-M2.1 platform-db and maps them to null', async () => {
    const { logflare_url: _u, logflare_token_enc: _t, ...legacyRow } = fullRow
    mockQuery
      .mockResolvedValueOnce({
        data: undefined,
        error: new Error('column "logflare_url" does not exist'),
      })
      .mockResolvedValueOnce({ data: [legacyRow], error: undefined })
    const row = await getProjectByRef('proj-b')
    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(mockQuery.mock.calls[1][0].query).not.toContain('logflare_url')
    expect(row).toEqual({ ...legacyRow, logflare_url: null, logflare_token_enc: null })
  })

  it('propagates other errors without retrying', async () => {
    mockQuery.mockResolvedValueOnce({
      data: undefined,
      error: new Error('relation "platform.projects" does not exist'),
    })
    await expect(listAllProjects()).rejects.toThrow('relation "platform.projects" does not exist')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})
