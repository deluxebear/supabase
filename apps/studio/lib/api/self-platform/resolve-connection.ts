// [self-platform] Single entry point for per-project connection resolution.
// Registry hit -> decrypt at-rest secrets, build DSN, re-encrypt with the
// pg-meta transport key. 'default' with no row -> fall back to M1 global env
// (zero-break). Unknown non-default ref -> ProjectNotFound (route maps to 404).
import { POSTGRES_PORT } from '../self-hosted/constants'
import { encryptString, getConnectionString } from '../self-hosted/util'
import { getProjectByRef, type PlatformProjectRow } from './projects'
import { decryptSecret } from './secrets'
import { PROJECT_DB_HOST, PROJECT_REST_URL } from '@/lib/constants/api'

export class ProjectNotFound extends Error {
  constructor(ref: string) {
    super(`Project not found: ${ref}`)
    this.name = 'ProjectNotFound'
  }
}

export interface ResolvedConnection {
  ref: string
  organizationId: number | null
  name: string
  status: string
  cloudProvider: string
  region: string
  pgConnEncrypted: string
  pgConnReadOnlyEncrypted: string
  supabaseUrl: string
  restUrl: string
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  serviceKey: string
  anonKey: string
  jwtSecret: string
  publishableKey: string | null
  secretKey: string | null
  // [self-platform] Raw registry row for a hit, null for the global-env
  // fallback. Lets callers (e.g. Task 6) map from the row without a second
  // getProjectByRef lookup.
  row: PlatformProjectRow | null
}

function fromRow(row: PlatformProjectRow): ResolvedConnection {
  const dbPass = decryptSecret(row.db_pass_enc)
  const rwDsn = `postgresql://${row.db_user}:${dbPass}@${row.db_host}:${row.db_port}/${row.db_name}`
  const roDsn = `postgresql://${row.db_user_readonly}:${dbPass}@${row.db_host}:${row.db_port}/${row.db_name}`
  return {
    ref: row.ref,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    cloudProvider: row.cloud_provider,
    region: row.region,
    pgConnEncrypted: encryptString(rwDsn),
    pgConnReadOnlyEncrypted: encryptString(roDsn),
    supabaseUrl: row.kong_url,
    restUrl: row.rest_url,
    dbHost: row.db_host,
    dbPort: row.db_port,
    dbName: row.db_name,
    dbUser: row.db_user,
    serviceKey: decryptSecret(row.service_key_enc),
    anonKey: decryptSecret(row.anon_key_enc),
    jwtSecret: decryptSecret(row.jwt_secret_enc),
    publishableKey: row.publishable_key_enc ? decryptSecret(row.publishable_key_enc) : null,
    secretKey: row.secret_key_enc ? decryptSecret(row.secret_key_enc) : null,
    row,
  }
}

// M1 global-env fallback for the historical single 'default' project.
function fromGlobalEnv(): ResolvedConnection {
  return {
    ref: 'default',
    organizationId: null,
    name: process.env.DEFAULT_PROJECT_NAME || 'Default Project',
    status: 'ACTIVE_HEALTHY',
    cloudProvider: 'AWS',
    region: 'local',
    pgConnEncrypted: encryptString(getConnectionString({ readOnly: false })),
    pgConnReadOnlyEncrypted: encryptString(getConnectionString({ readOnly: true })),
    supabaseUrl: process.env.SUPABASE_URL || '',
    restUrl: PROJECT_REST_URL,
    dbHost: PROJECT_DB_HOST,
    dbPort: POSTGRES_PORT,
    dbName: process.env.POSTGRES_DB || 'postgres',
    dbUser: process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    jwtSecret: process.env.AUTH_JWT_SECRET || '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || null,
    secretKey: process.env.SUPABASE_SECRET_KEY || null,
    row: null,
  }
}

export async function resolveProjectConnection(ref: string): Promise<ResolvedConnection> {
  const row = await getProjectByRef(ref)
  if (row) return fromRow(row)
  if (ref === 'default') {
    console.log('[self-platform] project registry miss for "default", using global env')
    return fromGlobalEnv()
  }
  throw new ProjectNotFound(ref)
}
