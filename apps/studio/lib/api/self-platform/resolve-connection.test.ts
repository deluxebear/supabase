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

  it('populates row: registry row for a hit, null for the default fallback', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(row as any)
    const hit = await resolveProjectConnection('proj-b')
    expect(hit.row).toBe(row)

    vi.mocked(getProjectByRef).mockResolvedValue(null)
    const fallback = await resolveProjectConnection('default')
    expect(fallback.row).toBeNull()
  })
})
