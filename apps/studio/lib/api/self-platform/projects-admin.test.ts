import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import { getProjectByRef } from './projects'
import {
  attachExternalProject,
  CreateDatabaseFailed,
  createSharedDbProject,
  deleteProjectByRef,
  DuplicateRef,
  InvalidHostStack,
  parseExternalConnectionInput,
  probeConnection,
  ProbeFailed,
  REF_PATTERN,
  refToDbName,
  RESERVED_REFS,
} from './projects-admin'
import { executeQuery } from '@/lib/api/self-hosted/query'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./projects', () => ({ getProjectByRef: vi.fn() }))
vi.mock('./secrets', () => ({ encryptSecret: vi.fn((s: string) => `enc(${s})`) }))
vi.mock('@/lib/api/self-hosted/query', () => ({ executeQuery: vi.fn() }))
vi.mock('@/lib/api/self-hosted/util', () => ({ encryptString: vi.fn(() => 'enc-dsn') }))
vi.mock('@/lib/api/apiHelpers', () => ({
  constructHeaders: vi.fn((h: Record<string, string>) => h),
}))

const HOST_ROW = {
  id: 1,
  ref: 'default',
  organization_id: 1,
  name: 'Default Project',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'supabase_read_only_user',
  kong_url: 'http://localhost:8100',
  rest_url: 'http://localhost:8100/rest/v1/',
  db_pass_enc: 'PASS_ENC',
  service_key_enc: 'SVC_ENC',
  anon_key_enc: 'ANON_ENC',
  jwt_secret_enc: 'JWT_ENC',
  publishable_key_enc: null,
  secret_key_enc: null,
  logflare_url: 'http://logflare:4000',
  logflare_token_enc: 'LF_ENC',
  stack_kind: 'external',
  stack_meta: {},
}

const CONNECTION = {
  dbHost: '10.0.0.9',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  dbUserReadonly: 'supabase_read_only_user',
  dbPass: 'pw',
  kongUrl: 'http://10.0.0.9:8000',
  restUrl: 'http://10.0.0.9:8000/rest/v1/',
  anonKey: 'anon',
  serviceKey: 'svc',
  jwtSecret: 'jwt',
}

beforeEach(() => {
  vi.mocked(executePlatformQuery)
    .mockReset()
    .mockResolvedValue({ data: [{ id: 7 }], error: undefined })
  vi.mocked(executeQuery)
    .mockReset()
    .mockResolvedValue({ data: [], error: undefined } as never)
  vi.mocked(getProjectByRef)
    .mockReset()
    .mockResolvedValue(HOST_ROW as never)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
})

describe('ref validation helpers', () => {
  it('REF_PATTERN accepts slugs, rejects bad shapes', () => {
    expect(REF_PATTERN.test('team-a')).toBe(true)
    expect(REF_PATTERN.test('p2')).toBe(false) // too short (min 3)
    expect(REF_PATTERN.test('2abc')).toBe(false) // must start with a letter
    expect(REF_PATTERN.test('Has-Upper')).toBe(false)
    expect(REF_PATTERN.test('a'.repeat(31))).toBe(false) // max 30
    expect(RESERVED_REFS.has('default')).toBe(true)
  })

  it('refToDbName maps hyphens to underscores', () => {
    expect(refToDbName('team-a-app')).toBe('team_a_app')
  })
})

describe('createSharedDbProject', () => {
  const input = { ref: 'team-a', name: 'Team A', hostRef: 'default', organizationId: 1 }

  it('inserts BEFORE creating the database (insert-first), then flips status', async () => {
    await createSharedDbProject(input)
    const insertOrder = vi.mocked(executePlatformQuery).mock.invocationCallOrder[0]
    const ddlOrder = vi.mocked(executeQuery).mock.invocationCallOrder[0]
    expect(insertOrder).toBeLessThan(ddlOrder)
    const insert = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(insert.query).toContain('insert into platform.projects')
    expect(insert.query).toContain("'COMING_UP'")
    expect(insert.query).toContain("'shared-db'")
    // logflare columns are NOT cloned — explicit nulls (per-ref no-fallback honesty)
    expect(insert.query).toMatch(/null,\s*null,\s*'shared-db'/)
    expect(insert.parameters).toEqual([
      'team-a',
      1,
      'Team A',
      'AWS',
      'local',
      'db',
      5432,
      'team_a',
      'supabase_admin',
      'supabase_read_only_user',
      'http://localhost:8100',
      'http://localhost:8100/rest/v1/',
      'PASS_ENC',
      'SVC_ENC',
      'ANON_ENC',
      'JWT_ENC',
      null,
      null,
      JSON.stringify({ host_ref: 'default' }),
    ])
    const ddl = vi.mocked(executeQuery).mock.calls[0][0]
    expect(ddl.query).toBe('create database "team_a"')
    expect(ddl.projectRef).toBe('default')
    const flip = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(flip.query).toContain("set status = 'ACTIVE_HEALTHY'")
    expect(flip.parameters).toEqual(['team-a'])
  })

  it('rejects a host that is not an external stack', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue({ ...HOST_ROW, stack_kind: 'shared-db' } as never)
    await expect(createSharedDbProject(input)).rejects.toBeInstanceOf(InvalidHostStack)
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })

  it('rejects a missing host', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(null)
    await expect(createSharedDbProject(input)).rejects.toBeInstanceOf(InvalidHostStack)
  })

  it('maps a unique violation to DuplicateRef without running DDL', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValueOnce({
      data: undefined,
      error: new Error('duplicate key value violates unique constraint "projects_ref_key"'),
    })
    await expect(createSharedDbProject(input)).rejects.toBeInstanceOf(DuplicateRef)
    expect(executeQuery).not.toHaveBeenCalled()
  })

  it('deletes the row when CREATE DATABASE fails', async () => {
    vi.mocked(executeQuery).mockResolvedValue({
      data: undefined,
      error: new Error('permission denied to create database'),
    } as never)
    await expect(createSharedDbProject(input)).rejects.toBeInstanceOf(CreateDatabaseFailed)
    await expect(createSharedDbProject(input)).rejects.toThrow(/CREATE DATABASE failed/)
    const cleanup = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(cleanup.query).toContain('delete from platform.projects where ref = $1')
    expect(cleanup.parameters).toEqual(['team-a'])
  })

  it('warns (but still throws CreateDatabaseFailed) when the compensating cleanup delete itself fails', async () => {
    vi.mocked(executeQuery).mockResolvedValue({
      data: undefined,
      error: new Error('permission denied to create database'),
    } as never)
    vi.mocked(executePlatformQuery)
      .mockReset()
      .mockResolvedValueOnce({ data: [{ id: 7 }], error: undefined }) // insert
      .mockResolvedValueOnce({ data: undefined, error: new Error('cleanup boom') }) // cleanup delete
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(createSharedDbProject(input)).rejects.toBeInstanceOf(CreateDatabaseFailed)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toMatch(/failed to clean up/)
    warnSpy.mockRestore()
  })

  it('rejects a host stack that belongs to a different organization', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue({ ...HOST_ROW, organization_id: 2 } as never)
    await expect(createSharedDbProject(input)).rejects.toBeInstanceOf(InvalidHostStack)
    await expect(createSharedDbProject(input)).rejects.toThrow(/different organization/)
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })

  it('re-validates ref in-module before any lookup or statement', async () => {
    await expect(createSharedDbProject({ ...input, ref: 'Bad"Ref' })).rejects.toThrow(
      /invalid project ref/
    )
    await expect(createSharedDbProject({ ...input, ref: 'default' })).rejects.toThrow(
      /invalid project ref/
    )
    expect(getProjectByRef).not.toHaveBeenCalled()
    expect(executePlatformQuery).not.toHaveBeenCalled()
    expect(executeQuery).not.toHaveBeenCalled()
  })
})

describe('probeConnection / attachExternalProject', () => {
  it('probe returns ok on select 1 success', async () => {
    expect(await probeConnection(CONNECTION)).toEqual({ ok: true })
  })

  it('probe surfaces the pg-meta error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'connect ECONNREFUSED' }),
      })
    )
    const out = await probeConnection(CONNECTION)
    expect(out).toEqual({ ok: false, error: 'connect ECONNREFUSED' })
  })

  it('attach probes first and does not insert on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(
      attachExternalProject({
        ref: 'ext-1',
        name: 'Ext',
        organizationId: 1,
        connection: CONNECTION,
      })
    ).rejects.toBeInstanceOf(ProbeFailed)
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })

  it('attach encrypts secrets and inserts an ACTIVE_HEALTHY external row', async () => {
    await attachExternalProject({
      ref: 'ext-1',
      name: 'Ext',
      organizationId: 1,
      connection: CONNECTION,
    })
    const insert = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(insert.query).toContain("'ACTIVE_HEALTHY'")
    expect(insert.query).toContain("'external'")
    expect(insert.parameters).toContain('enc(pw)')
    expect(insert.parameters).toContain('enc(jwt)')
    expect(insert.parameters).not.toContain('pw') // no plaintext secret bound
  })

  it('parseExternalConnectionInput enforces required fields and derives restUrl', () => {
    const bad = parseExternalConnectionInput({ dbHost: 'h' })
    expect('error' in bad && bad.error).toMatch(/dbPass/)
    const good = parseExternalConnectionInput({
      dbHost: 'h',
      dbPass: 'p',
      kongUrl: 'http://k:8000/',
      anonKey: 'a',
      serviceKey: 's',
      jwtSecret: 'j',
    })
    if ('error' in good) throw new Error('expected value')
    expect(good.value.restUrl).toBe('http://k:8000/rest/v1/')
    expect(good.value.dbPort).toBe(5432)
    expect(good.value.dbUser).toBe('supabase_admin')
  })
})

describe('deleteProjectByRef', () => {
  it('runs delete then GC as TWO sequential statements', async () => {
    await deleteProjectByRef('team-a')
    const calls = vi.mocked(executePlatformQuery).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0].query).toContain('delete from platform.projects where ref = $1')
    expect(calls[0][0].parameters).toEqual(['team-a'])
    // GC MUST be a separate statement (same-snapshot CTE semantics, M1 I1-BUG
    // class): the cascade's role_projects deletions are invisible to CTEs of
    // the deleting statement itself.
    expect(calls[1][0].query).toContain('base_role_id <> r.id')
    expect(calls[1][0].query).toContain('not exists')
  })

  it('returns false and skips GC when no row matched', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await deleteProjectByRef('ghost')).toBe(false)
    expect(vi.mocked(executePlatformQuery).mock.calls).toHaveLength(1)
  })

  it('refuses to deregister a reserved ref without querying the db', async () => {
    await expect(deleteProjectByRef('default')).rejects.toThrow(/reserved ref/)
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })
})
