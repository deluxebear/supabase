import { describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  getProjectByRef,
  listProjectsByOrgId,
  toDatabaseDetailResponse,
  toProjectDetailResponse,
  toProjectSettingsResponse,
} from './projects'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const row = {
  id: 5,
  ref: 'proj-b',
  organization_id: 1,
  name: 'Project B',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db-b',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'supabase_read_only_user',
  kong_url: 'http://kong-b:8000',
  rest_url: 'http://kong-b:8000/rest/v1/',
  db_pass_enc: 'x',
  service_key_enc: 'x',
  anon_key_enc: 'x',
  jwt_secret_enc: 'x',
  publishable_key_enc: null,
  secret_key_enc: null,
}

describe('getProjectByRef', () => {
  it('binds ref and returns null on miss', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await getProjectByRef('nope')).toBeNull()
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual(['nope'])
    expect(call.query).not.toContain('nope')
  })
})

describe('listProjectsByOrgId', () => {
  it('binds org id', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })
    expect(await listProjectsByOrgId(1)).toEqual([row])
    expect(vi.mocked(executePlatformQuery).mock.calls.at(-1)![0].parameters).toEqual([1])
  })
})

describe('mappers', () => {
  it('toProjectDetailResponse carries ref/org/status + passed-in encrypted conn string', () => {
    const res = toProjectDetailResponse(row, 'ENC')
    expect(res).toMatchObject({
      ref: 'proj-b',
      organization_id: 1,
      name: 'Project B',
      status: 'ACTIVE_HEALTHY',
      db_host: 'db-b',
      restUrl: 'http://kong-b:8000/rest/v1/',
      connectionString: 'ENC',
      cloud_provider: 'AWS',
      region: 'local',
    })
  })
  it('toDatabaseDetailResponse uses identifier=ref + both encrypted conn strings', () => {
    const res = toDatabaseDetailResponse(row, 'ENC', 'ENC_RO')
    expect(res).toMatchObject({
      identifier: 'proj-b',
      db_host: 'db-b',
      db_port: 5432,
      connectionString: 'ENC',
      connection_string_read_only: 'ENC_RO',
      status: 'ACTIVE_HEALTHY',
    })
  })
  it('toProjectSettingsResponse builds service_api_keys from decrypted values', () => {
    const res = toProjectSettingsResponse(row, {
      jwtSecret: 'JWT',
      anonKey: 'ANON',
      serviceKey: 'SVC',
    })
    expect(res.jwt_secret).toBe('JWT')
    expect(res.service_api_keys).toEqual([
      { api_key: 'ANON', name: 'anon key', tags: 'anon' },
      { api_key: 'SVC', name: 'service_role key', tags: 'service_role' },
    ])
    expect(res).toMatchObject({ ref: 'proj-b', db_host: 'db-b', db_port: 5432 })
  })
})
