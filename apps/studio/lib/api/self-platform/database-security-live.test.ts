import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getDatabaseSecurityPolicy } from './database-security'
import { mapSupavisorTenant, readLiveDatabaseSecurity } from './database-security-live'
import { executePlatformQuery } from './db'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./secrets', () => ({ decryptSecret: (value: string) => value.replace('enc:', '') }))
vi.mock('../self-hosted/util', () => ({ encryptString: (value: string) => `encrypted:${value}` }))
vi.mock('./resolve-connection', () => ({
  resolveProjectConnection: vi.fn().mockResolvedValue({
    supabaseUrl: 'http://gateway:8000',
    serviceKey: 'service',
    pgConnEncrypted: 'encrypted:postgres-db',
    pgConnReadOnlyEncrypted: 'encrypted:readonly',
    row: {
      db_host: 'db',
      db_port: 5432,
      db_user: 'postgres',
      db_pass_enc: 'enc:secret',
      tls_mode: 'disable',
      tls_ca_reference: null,
    },
  }),
}))

const tenant = {
  default_pool_size: 20,
  default_max_clients: 100,
  allow_list: ['0.0.0.0/0', '::/0'],
}
const storedRow = {
  generation: 0,
  ssl_enforced: false,
  tls_ca_reference: null,
  allowed_cidrs: [],
  default_pool_size: 15,
  max_client_connections: 200,
  state: 'ready',
  operation_id: null,
  error_code: null,
  observed_at: null,
}

describe('live database security settings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [storedRow], error: undefined })
  })

  it('maps the Supavisor tenant and treats the allow-all pair as no restriction', () => {
    expect(mapSupavisorTenant(tenant)).toEqual({
      network: { allowedCidrs: [] },
      pooler: { defaultPoolSize: 20, maxClientConnections: 100 },
    })
    expect(mapSupavisorTenant({ ...tenant, allow_list: ['10.0.0.0/8'] })?.network).toEqual({
      allowedCidrs: ['10.0.0.0/8'],
    })
    expect(mapSupavisorTenant(undefined)).toBeNull()
  })

  it('reads the Supavisor catalog database through pg-meta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json([tenant]))
    expect(await readLiveDatabaseSecurity('project-a', fetchImpl)).not.toBeNull()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://gateway:8000/pg/query')
    expect(init.headers['x-connection-encrypted']).toBe(
      'encrypted:postgresql://postgres:secret@db:5432/_supabase?sslmode=disable'
    )
  })

  it('shows running values until Fleet applies a policy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([tenant])))
    const policy = await getDatabaseSecurityPolicy('project-a', { withLiveValues: true })
    expect(policy.pooler).toEqual({ defaultPoolSize: 20, maxClientConnections: 100 })
    expect(policy.generation).toBe(0)
  })

  it('keeps the stored policy once Fleet has applied one', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        { ...storedRow, generation: 2, operation_id: 'op-1', observed_at: '2026-10-12T00:00:00Z' },
      ],
      error: undefined,
    })
    const policy = await getDatabaseSecurityPolicy('project-a', { withLiveValues: true })
    expect(policy.pooler).toEqual({ defaultPoolSize: 15, maxClientConnections: 200 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to the stored policy when the catalog cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    const policy = await getDatabaseSecurityPolicy('project-a', { withLiveValues: true })
    expect(policy.pooler).toEqual({ defaultPoolSize: 15, maxClientConnections: 200 })
  })
})
