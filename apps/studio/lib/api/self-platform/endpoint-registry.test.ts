import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  findProjectEndpointRegistryForFunctionUrl,
  isRegisteredFunctionUrl,
  publicProjectEndpointsFromDocument,
  safeLegacyPublicUrl,
  validatePublicProjectEndpoints,
} from './endpoint-registry'
import { executePlatformQuery } from './db'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

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
  beforeEach(() => {
    vi.mocked(executePlatformQuery).mockReset()
  })

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

  it('accepts only function URLs below the registered Functions endpoint', () => {
    const registered = endpoints.functionsUrl

    expect(isRegisteredFunctionUrl(`${registered}/hello`, registered)).toBe(true)
    expect(isRegisteredFunctionUrl(`${registered}/hello/sub-path?name=value`, registered)).toBe(
      true
    )
    expect(isRegisteredFunctionUrl(`${registered}/hello`, `${registered}/`)).toBe(true)

    for (const url of [
      registered,
      `${registered}//hello`,
      `${registered}.attacker.example/hello`,
      'http://192.168.50.149:8301/functions/v1/hello',
      'http://attacker.example/functions/v1/hello',
      `http://user@192.168.50.149:8200/functions/v1/hello`,
      `${registered}/hello#fragment`,
      'not-a-url',
    ]) {
      expect(isRegisteredFunctionUrl(url, registered), `Expected ${url} to be rejected`).toBe(false)
    }
  })

  it('finds a Fleet endpoint registry only when the function URL matches it', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          active_connection_revision: 4,
          endpoint_document: { contractVersion: 'v1', public: endpoints },
        },
      ],
      error: undefined,
    })
    const functionUrl = `${endpoints.functionsUrl}/hello?name=value`

    await expect(findProjectEndpointRegistryForFunctionUrl(functionUrl)).resolves.toEqual({
      revision: 4,
      endpoints,
    })
    expect(executePlatformQuery).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: [functionUrl] })
    )
  })

  it('rejects malformed and unregistered function URLs without forwarding them', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          active_connection_revision: 4,
          endpoint_document: { contractVersion: 'v1', public: endpoints },
        },
      ],
      error: undefined,
    })

    await expect(
      findProjectEndpointRegistryForFunctionUrl(
        'http://attacker.example/functions/v1/hello'
      )
    ).resolves.toBeNull()
    await expect(findProjectEndpointRegistryForFunctionUrl('not-a-url')).resolves.toBeNull()
  })
})
