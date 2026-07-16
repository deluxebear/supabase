import { describe, expect, it } from 'vitest'

import {
  publicProjectEndpointsFromDocument,
  safeLegacyPublicUrl,
  validatePublicProjectEndpoints,
} from './endpoint-registry'

const endpoints = {
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
    tenantId: 'project-a',
    tlsMode: 'disable',
  },
} as const

describe('Fleet endpoint registry validation', () => {
  it('accepts a complete routable public endpoint document', () => {
    expect(validatePublicProjectEndpoints(endpoints)).toEqual(endpoints)
    expect(
      publicProjectEndpointsFromDocument({ contractVersion: 'v1', public: endpoints })
    ).toEqual(endpoints)
  })

  it('rejects Docker-only service and database hosts', () => {
    expect(() =>
      validatePublicProjectEndpoints({ ...endpoints, apiUrl: 'http://kong-project-a:8000' })
    ).toThrow(/Docker-only/)
    expect(() =>
      validatePublicProjectEndpoints({
        ...endpoints,
        directPostgres: { ...endpoints.directPostgres, host: 'db-project-a' },
      })
    ).toThrow(/Docker-only/)
  })

  it('does not treat a legacy Docker URL as a public fallback', () => {
    expect(safeLegacyPublicUrl('http://kong-project-a:8000')).toBeNull()
    expect(safeLegacyPublicUrl('http://192.168.50.149:8200')).toBe('http://192.168.50.149:8200/')
  })
})
