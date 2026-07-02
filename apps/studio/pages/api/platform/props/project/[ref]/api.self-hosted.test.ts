// [self-platform] Zero-break coverage for plain self-hosted (self-platform
// off). api.test.ts hoists NEXT_PUBLIC_SELF_PLATFORM=true, so this sibling
// covers the off-branch with a fresh module load per Task 6's pattern (see
// pages/api/platform/projects/[ref]/index.self-hosted.test.ts).
import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  resolveProjectConnection.mockReset()
})

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://localhost:8000')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-global')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-global')
  return (await import('./api')).handler
}

describe('GET /platform/props/project/{ref}/api (plain self-hosted, zero-break)', () => {
  it('returns the historical global literal, byte-identical, when self-platform is off', async () => {
    const handler = await loadHandler('')

    // Re-derive the constants from the same (fresh) module registry / stubbed
    // env that the route module itself sees, so the expectation tracks the
    // literal rather than hardcoding a second copy of derived values.
    const { POSTGRES_PORT } = await import('@/lib/api/self-hosted/constants')
    const {
      DEFAULT_PROJECT,
      PROJECT_DB_HOST,
      PROJECT_ENDPOINT,
      PROJECT_ENDPOINT_PROTOCOL,
      PROJECT_REST_URL,
    } = await import('@/lib/constants/api')

    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as any, res as any)

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({
      project: {
        ...DEFAULT_PROJECT,
        api_key_supabase_encrypted: '',
        db_host: PROJECT_DB_HOST,
        db_name: 'postgres',
        db_port: POSTGRES_PORT,
        db_ssl: false,
        db_user: 'postgres',
        services: [
          {
            id: 1,
            name: 'Default API',
            app: { id: 1, name: 'Auto API' },
            app_config: {
              db_schema: 'public',
              endpoint: PROJECT_ENDPOINT,
              realtime_enabled: true,
            },
            service_api_keys: [
              {
                api_key_encrypted: '-',
                name: 'service_role key',
                tags: 'service_role',
              },
              {
                api_key_encrypted: '-',
                name: 'anon key',
                tags: 'anon',
              },
            ],
          },
        ],
      },
      autoApiService: {
        id: 1,
        name: 'Default API',
        project: { ref: 'default' },
        app: { id: 1, name: 'Auto API' },
        app_config: {
          db_schema: 'public',
          endpoint: PROJECT_ENDPOINT,
          realtime_enabled: true,
        },
        protocol: PROJECT_ENDPOINT_PROTOCOL,
        endpoint: PROJECT_ENDPOINT,
        restUrl: PROJECT_REST_URL,
        defaultApiKey: 'anon-global',
        serviceApiKey: 'service-global',
        service_api_keys: [
          {
            api_key_encrypted: '-',
            name: 'service_role key',
            tags: 'service_role',
          },
          {
            api_key_encrypted: '-',
            name: 'anon key',
            tags: 'anon',
          },
        ],
      },
    })
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })

  it('405s a non-GET method', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(405)
  })
})
