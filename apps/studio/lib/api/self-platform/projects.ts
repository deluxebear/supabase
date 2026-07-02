// [self-platform] platform.projects data access + api-types contract mapping.
// Mirrors organizations.ts pattern. Mappers take the pg-meta-encrypted
// connection string(s) as args (produced by resolve-connection.ts) so this
// module stays free of the transport-encryption concern.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

export interface PlatformProjectRow {
  id: number
  ref: string
  organization_id: number
  name: string
  status: string
  cloud_provider: string
  region: string
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_user_readonly: string
  kong_url: string
  rest_url: string
  db_pass_enc: string
  service_key_enc: string
  anon_key_enc: string
  jwt_secret_enc: string
  publishable_key_enc: string | null
  secret_key_enc: string | null
}

type ProjectDetailResponse = components['schemas']['ProjectDetailResponse']
type DatabaseDetailResponse = components['schemas']['DatabaseDetailResponse']
type ProjectSettingsResponse = components['schemas']['ProjectSettingsResponse']

export const PROJECT_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc
`

export async function getProjectByRef(ref: string): Promise<PlatformProjectRow | null> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects where ref = $1`,
    parameters: [ref],
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function listProjectsByOrgId(orgId: number): Promise<PlatformProjectRow[]> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects where organization_id = $1 order by id`,
    parameters: [orgId],
  })
  if (error) throw error
  return data ?? []
}

export async function listAllProjects(): Promise<PlatformProjectRow[]> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects order by id`,
  })
  if (error) throw error
  return data ?? []
}

export function toProjectDetailResponse(
  row: PlatformProjectRow,
  connectionStringEnc: string
): ProjectDetailResponse {
  return {
    cloud_provider: row.cloud_provider,
    connectionString: connectionStringEnc,
    db_host: row.db_host,
    high_availability: false,
    id: row.id,
    inserted_at: '2021-08-02T06:40:40.646Z',
    integration_source: null,
    is_branch_enabled: false,
    is_physical_backups_enabled: false,
    name: row.name,
    organization_id: row.organization_id,
    ref: row.ref,
    region: row.region,
    restUrl: row.rest_url,
    status: row.status as ProjectDetailResponse['status'],
    subscription_id: '',
    updated_at: '2021-08-02T06:40:40.646Z',
  }
}

export function toDatabaseDetailResponse(
  row: PlatformProjectRow,
  connEnc: string,
  connRoEnc: string
): DatabaseDetailResponse {
  return {
    cloud_provider: 'AWS',
    connectionString: connEnc,
    connection_string_read_only: connRoEnc,
    db_host: row.db_host,
    db_name: row.db_name,
    db_port: row.db_port,
    db_user: row.db_user,
    identifier: row.ref,
    inserted_at: '2021-08-02T06:40:40.646Z',
    region: row.region,
    restUrl: row.rest_url,
    size: '',
    status: row.status as DatabaseDetailResponse['status'],
  }
}

export function toProjectSettingsResponse(
  row: PlatformProjectRow,
  decrypted: { jwtSecret: string; anonKey: string; serviceKey: string }
): ProjectSettingsResponse {
  return {
    app_config: {
      db_schema: 'public',
      endpoint: row.kong_url,
      storage_endpoint: row.kong_url,
    },
    cloud_provider: row.cloud_provider,
    db_dns_name: '-',
    db_host: row.db_host,
    db_ip_addr_config: 'legacy',
    db_name: row.db_name,
    db_port: row.db_port,
    db_user: row.db_user,
    inserted_at: '2021-08-02T06:40:40.646Z',
    jwt_secret: decrypted.jwtSecret,
    name: row.name,
    ref: row.ref,
    region: row.region,
    service_api_keys: [
      { api_key: decrypted.anonKey, name: 'anon key', tags: 'anon' },
      { api_key: decrypted.serviceKey, name: 'service_role key', tags: 'service_role' },
    ],
    ssl_enforced: false,
    status: row.status,
  }
}
