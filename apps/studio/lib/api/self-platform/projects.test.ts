import { describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  countProjectsByOrgIdAndIds,
  countProjectsVisible,
  getProjectByRef,
  listProjectsByOrgId,
  listProjectsByOrgIdAndIds,
  listProjectsVisible,
  toProjectDetailResponse,
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
  logflare_url: null,
  logflare_token_enc: null,
  metrics_url: null,
  metrics_token_enc: null,
  stack_kind: 'external',
  stack_meta: {},
}

function legacyRowWithoutStackFields() {
  const { stack_kind: _stackKind, stack_meta: _stackMeta, ...rest } = row
  return rest
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
    expect(vi.mocked(executePlatformQuery).mock.calls.at(-1)![0].parameters).toEqual([1, 100, 0])
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
})

describe('visibility-scoped queries (M3.0)', () => {
  it('listProjectsVisible parameterizes org ids and project ids', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await listProjectsVisible([1], [10, 11], 50, 5)
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.query).toContain('organization_id = any($1) or id = any($2)')
    expect(call.parameters).toEqual([[1], [10, 11], 50, 5])
  })

  it('countProjectsVisible / countProjectsByOrgIdAndIds return int counts', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [{ count: 3 }], error: undefined })
    expect(await countProjectsVisible([1], [])).toBe(3)
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [{ count: 2 }], error: undefined })
    expect(await countProjectsByOrgIdAndIds(1, [10])).toBe(2)
  })

  it('listProjectsByOrgIdAndIds constrains by org AND ids', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await listProjectsByOrgIdAndIds(1, [10], 100, 0)
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.query).toContain('organization_id = $1 and id = any($2)')
    expect(call.parameters).toEqual([1, [10], 100, 0])
  })
})

describe('stack columns degradation (M5.0)', () => {
  it('retries with M21 columns on missing stack_kind and defaults the fields', async () => {
    vi.mocked(executePlatformQuery)
      .mockResolvedValueOnce({
        data: undefined,
        error: new Error('column "stack_kind" does not exist'),
      })
      .mockResolvedValueOnce({ data: [legacyRowWithoutStackFields()], error: undefined })
    const row = await getProjectByRef('default')
    expect(row?.stack_kind).toBe('external')
    expect(row?.stack_meta).toEqual({})
    const retry = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(retry.query).not.toContain('stack_kind')
  })

  it('selects stack_kind and stack_meta in the primary column list', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await getProjectByRef('x')
    const call = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(call.query).toContain('stack_kind')
    expect(call.query).toContain('stack_meta')
  })
})
