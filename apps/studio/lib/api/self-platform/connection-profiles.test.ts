import { describe, expect, it } from 'vitest'

import {
  buildFleetConnectionProfiles,
  connectionProfileUri,
  toSupavisorConfiguration,
} from './connection-profiles'
import type { PublicProjectEndpoints } from './endpoint-registry'

const endpoints: PublicProjectEndpoints = {
  apiUrl: 'http://192.168.50.149:8200',
  restUrl: 'http://192.168.50.149:8200/rest/v1/',
  authUrl: 'http://192.168.50.149:8200/auth/v1',
  storageUrl: 'http://192.168.50.149:8200/storage/v1',
  realtimeUrl: 'http://192.168.50.149:8200/realtime/v1',
  functionsUrl: 'http://192.168.50.149:8200/functions/v1',
  s3Url: 'http://192.168.50.149:8200/storage/v1/s3',
  directPostgres: {
    host: '192.168.50.149',
    port: 55433,
    database: 'postgres',
    user: 'postgres',
    tlsMode: 'disable',
  },
  supavisor: {
    host: '192.168.50.149',
    transactionPort: 56543,
    sessionPort: 55432,
    database: 'postgres',
    user: 'postgres',
    tenantId: 'your-tenant-id',
    tlsMode: 'disable',
  },
}

describe('Fleet connection profiles', () => {
  it('builds direct, transaction, session, and read-only profiles without passwords', () => {
    const profiles = buildFleetConnectionProfiles(endpoints, 'supabase_read_only_user')
    expect(profiles.map(({ id, port, user }) => ({ id, port, user }))).toEqual([
      { id: 'direct', port: 55433, user: 'postgres' },
      { id: 'transaction', port: 56543, user: 'postgres.your-tenant-id' },
      { id: 'session', port: 55432, user: 'postgres.your-tenant-id' },
      { id: 'read_only', port: 55433, user: 'supabase_read_only_user' },
    ])
    expect(JSON.stringify(profiles)).not.toContain('password')
  })

  it('adapts transaction and session profiles to the existing Supavisor API shape', () => {
    const profiles = buildFleetConnectionProfiles(endpoints, 'supabase_read_only_user')
    const config = toSupavisorConfiguration('project-a', profiles)
    expect(config.map(({ pool_mode, db_port }) => ({ pool_mode, db_port }))).toEqual([
      { pool_mode: 'transaction', db_port: 56543 },
      { pool_mode: 'session', db_port: 55432 },
    ])
    expect(connectionProfileUri(profiles[1])).toContain(':[YOUR-PASSWORD]@')
  })
})
