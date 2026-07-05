import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectByRef } from './projects'
import { resolveProjectConnection } from './resolve-connection'
import { decryptSecret } from './secrets'

vi.mock('./projects', () => ({ getProjectByRef: vi.fn() }))
vi.mock('./secrets', () => ({ decryptSecret: vi.fn((c: string) => `dec(${c})`) }))
vi.mock('../self-hosted/util', () => ({
  encryptString: vi.fn(() => 'transport-enc'),
  getConnectionString: vi.fn(() => 'postgresql://global'),
}))

const row = {
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
  db_pass_enc: 'p',
  service_key_enc: 's',
  anon_key_enc: 'a',
  jwt_secret_enc: 'j',
  publishable_key_enc: null,
  secret_key_enc: null,
  logflare_url: 'http://localhost:8100/analytics',
  logflare_token_enc: 'lt',
  stack_kind: 'external',
  stack_meta: {},
}

beforeEach(() => vi.mocked(getProjectByRef).mockReset())

describe('resolveProjectConnection analytics fields', () => {
  it('decrypts logflare token on a registry hit', async () => {
    vi.mocked(getProjectByRef).mockResolvedValueOnce(row as any)
    const conn = await resolveProjectConnection('proj-b')
    expect(conn.logflareUrl).toBe('http://localhost:8100/analytics')
    expect(conn.logflareToken).toBe('dec(lt)')
    expect(decryptSecret).toHaveBeenCalledWith('lt')
  })

  it('keeps NULL analytics fields null (no env fallback on a hit)', async () => {
    vi.stubEnv('LOGFLARE_URL', 'http://global-logflare')
    vi.mocked(getProjectByRef).mockResolvedValueOnce({
      ...row,
      logflare_url: null,
      logflare_token_enc: null,
    } as any)
    const conn = await resolveProjectConnection('proj-b')
    expect(conn.logflareUrl).toBeNull()
    expect(conn.logflareToken).toBeNull()
    vi.unstubAllEnvs()
  })

  it('global fallback for unregistered default picks env', async () => {
    vi.stubEnv('LOGFLARE_URL', 'http://global-logflare')
    vi.stubEnv('LOGFLARE_PRIVATE_ACCESS_TOKEN', 'global-token')
    vi.mocked(getProjectByRef).mockResolvedValueOnce(null)
    const conn = await resolveProjectConnection('default')
    expect(conn.logflareUrl).toBe('http://global-logflare')
    expect(conn.logflareToken).toBe('global-token')
    vi.unstubAllEnvs()
  })
})
