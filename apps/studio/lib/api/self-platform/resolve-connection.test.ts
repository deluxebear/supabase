import { afterEach, describe, expect, it, vi } from 'vitest'

import { getProjectByRef } from './projects'
import { ProjectNotFound, resolveProjectConnection } from './resolve-connection'

vi.mock('./projects', () => ({ getProjectByRef: vi.fn() }))
vi.mock('./secrets', () => ({ decryptSecret: (s: string) => `dec(${s})` }))
vi.mock('../self-hosted/util', () => ({
  encryptString: (s: string) => `enc(${s})`,
  getConnectionString: ({ readOnly }: { readOnly: boolean }) =>
    readOnly ? 'postgresql://ro@global/postgres' : 'postgresql://rw@global/postgres',
}))

const row = {
  id: 5,
  ref: 'proj-b',
  organization_id: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db-b',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'ro_user',
  kong_url: 'http://kong-b:8000',
  rest_url: 'http://kong-b:8000/rest/v1/',
  db_pass_enc: 'PWENC',
  service_key_enc: 'SVCENC',
  anon_key_enc: 'ANONENC',
  jwt_secret_enc: 'JWTENC',
  publishable_key_enc: null,
  secret_key_enc: null,
  stack_kind: 'external',
  stack_meta: {},
}

afterEach(() => vi.clearAllMocks())

describe('resolveProjectConnection', () => {
  it('resolves a registered project: decrypts secrets and re-encrypts DSN for pg-meta', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(row as any)
    const r = await resolveProjectConnection('proj-b')
    expect(r.ref).toBe('proj-b')
    expect(r.serviceKey).toBe('dec(SVCENC)')
    expect(r.jwtSecret).toBe('dec(JWTENC)')
    expect(r.supabaseUrl).toBe('http://kong-b:8000')
    // DSN built from row + decrypted pass, then encrypted for transport
    expect(r.pgConnEncrypted).toBe('enc(postgresql://supabase_admin:dec(PWENC)@db-b:5432/postgres)')
    expect(r.pgConnReadOnlyEncrypted).toBe(
      'enc(postgresql://ro_user:dec(PWENC)@db-b:5432/postgres)'
    )
  })

  it('falls back to global env for default when no registry row', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(null)
    const r = await resolveProjectConnection('default')
    expect(r.pgConnEncrypted).toBe('enc(postgresql://rw@global/postgres)')
    expect(r.pgConnReadOnlyEncrypted).toBe('enc(postgresql://ro@global/postgres)')
  })

  it('throws ProjectNotFound for an unknown non-default ref', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(null)
    await expect(resolveProjectConnection('ghost')).rejects.toBeInstanceOf(ProjectNotFound)
  })

  // [self-platform] IMPORTANT 3(a) — M1->M2 upgrade path: an existing M1
  // platform-db data dir never gets the 02-projects.sql migration (it only
  // runs on an empty data dir), so getProjectByRef throws undefined-table on
  // every ref. Must not 500 for the default project — fall through to the
  // global-env fallback like a normal miss.
  it('treats a missing platform.projects table as a registry miss for "default"', async () => {
    vi.mocked(getProjectByRef).mockRejectedValue(
      new Error('relation "platform.projects" does not exist')
    )
    const r = await resolveProjectConnection('default')
    expect(r.pgConnEncrypted).toBe('enc(postgresql://rw@global/postgres)')
    expect(r.row).toBeNull()
  })

  it('still throws ProjectNotFound for a non-default ref when the table is missing', async () => {
    vi.mocked(getProjectByRef).mockRejectedValue(
      new Error('relation "platform.projects" does not exist')
    )
    await expect(resolveProjectConnection('proj-b')).rejects.toBeInstanceOf(ProjectNotFound)
  })

  it('re-throws unrelated getProjectByRef errors instead of treating them as a miss', async () => {
    vi.mocked(getProjectByRef).mockRejectedValue(new Error('connection refused'))
    await expect(resolveProjectConnection('default')).rejects.toThrow('connection refused')
  })

  it('populates row: registry row for a hit, null for the default fallback', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(row as any)
    const hit = await resolveProjectConnection('proj-b')
    expect(hit.row).toBe(row)

    vi.mocked(getProjectByRef).mockResolvedValue(null)
    const fallback = await resolveProjectConnection('default')
    expect(fallback.row).toBeNull()
  })
})
