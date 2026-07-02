import { components } from 'api-types'

import { AUTH_JWT_SECRET, POSTGRES_PORT } from './constants'
import { assertSelfHosted } from './util'
import type { ResolvedConnection } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_DB_HOST, PROJECT_ENDPOINT, PROJECT_ENDPOINT_PROTOCOL } from '@/lib/constants/api'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse']['app_config'] & {
  protocol?: string
}

export type ProjectSettings = components['schemas']['ProjectSettingsResponse'] & {
  app_config?: ProjectAppConfig
}

/**
 * Gets self-hosted project settings
 *
 * _Only call this from server-side self-hosted code._
 *
 * // [self-platform] Optional `resolved` param: with it, returns the
 * // per-project values for a registry-resolved connection (self-platform
 * // multi-project). Without it, the historical global-env path — byte
 * // identical to M1 — keeps plain self-hosted zero-break.
 */
export function getProjectSettings(resolved?: ResolvedConnection) {
  assertSelfHosted()

  if (resolved) {
    return {
      app_config: {
        db_schema: 'public',
        endpoint: resolved.supabaseUrl,
        storage_endpoint: resolved.supabaseUrl,
        protocol: PROJECT_ENDPOINT_PROTOCOL,
      },
      cloud_provider: resolved.cloudProvider,
      db_dns_name: '-',
      db_host: resolved.dbHost,
      db_ip_addr_config: 'legacy' as const,
      db_name: resolved.dbName,
      db_port: resolved.dbPort,
      db_user: resolved.dbUser,
      inserted_at: '2021-08-02T06:40:40.646Z',
      jwt_secret: resolved.jwtSecret,
      name: resolved.name,
      ref: resolved.ref,
      region: resolved.region,
      service_api_keys: [
        { api_key: resolved.anonKey, name: 'anon key', tags: 'anon' },
        { api_key: resolved.serviceKey, name: 'service_role key', tags: 'service_role' },
      ],
      ssl_enforced: false,
      status: resolved.status,
    } satisfies ProjectSettings
  }

  // Plain self-hosted global-env path (unchanged from M1).
  return {
    app_config: {
      db_schema: 'public',
      endpoint: PROJECT_ENDPOINT,
      storage_endpoint: PROJECT_ENDPOINT,
      // manually added to force the frontend to use the correct URL
      protocol: PROJECT_ENDPOINT_PROTOCOL,
    },
    cloud_provider: 'AWS',
    db_dns_name: '-',
    db_host: PROJECT_DB_HOST,
    db_ip_addr_config: 'legacy' as const,
    db_name: 'postgres',
    db_port: POSTGRES_PORT,
    db_user: 'postgres',
    inserted_at: '2021-08-02T06:40:40.646Z',
    jwt_secret: AUTH_JWT_SECRET,
    name: process.env.DEFAULT_PROJECT_NAME || 'Default Project',
    ref: 'default',
    region: 'local',
    service_api_keys: [
      {
        api_key: process.env.SUPABASE_ANON_KEY ?? '',
        name: 'anon key',
        tags: 'anon',
      },
      {
        api_key: process.env.SUPABASE_SERVICE_KEY ?? '',
        name: 'service_role key',
        tags: 'service_role',
      },
    ],
    ssl_enforced: false,
    status: 'ACTIVE_HEALTHY',
  } satisfies ProjectSettings
}
