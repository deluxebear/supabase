import type { PublicProjectEndpoints } from './endpoint-registry'

export type FleetConnectionProfile = {
  id: 'direct' | 'transaction' | 'session' | 'read_only'
  host: string
  port: number
  database: string
  user: string
  tlsMode: PublicProjectEndpoints['directPostgres']['tlsMode']
  poolMode: 'direct' | 'transaction' | 'session'
}

export function buildFleetConnectionProfiles(
  endpoints: PublicProjectEndpoints,
  readOnlyUser: string
): FleetConnectionProfile[] {
  const { directPostgres, supavisor } = endpoints
  const poolerUser = `${supavisor.user}.${supavisor.tenantId}`
  return [
    {
      id: 'direct',
      host: directPostgres.host,
      port: directPostgres.port,
      database: directPostgres.database,
      user: directPostgres.user,
      tlsMode: directPostgres.tlsMode,
      poolMode: 'direct',
    },
    {
      id: 'transaction',
      host: supavisor.host,
      port: supavisor.transactionPort,
      database: supavisor.database,
      user: poolerUser,
      tlsMode: supavisor.tlsMode,
      poolMode: 'transaction',
    },
    {
      id: 'session',
      host: supavisor.host,
      port: supavisor.sessionPort,
      database: supavisor.database,
      user: poolerUser,
      tlsMode: supavisor.tlsMode,
      poolMode: 'session',
    },
    {
      id: 'read_only',
      host: directPostgres.host,
      port: directPostgres.port,
      database: directPostgres.database,
      user: readOnlyUser,
      tlsMode: directPostgres.tlsMode,
      poolMode: 'direct',
    },
  ]
}

export function connectionProfileUri(profile: FleetConnectionProfile): string {
  const tls = profile.tlsMode === 'disable' ? 'disable' : profile.tlsMode
  return `postgresql://${profile.user}:[YOUR-PASSWORD]@${profile.host}:${profile.port}/${profile.database}?sslmode=${tls}`
}

export function toSupavisorConfiguration(projectRef: string, profiles: FleetConnectionProfile[]) {
  return profiles
    .filter(
      (profile): profile is FleetConnectionProfile & { poolMode: 'transaction' | 'session' } =>
        profile.poolMode === 'transaction' || profile.poolMode === 'session'
    )
    .map((profile) => ({
      identifier: projectRef,
      database_type: 'PRIMARY' as const,
      db_host: profile.host,
      db_port: profile.port,
      db_name: profile.database,
      db_user: profile.user,
      pool_mode: profile.poolMode,
      connection_string: connectionProfileUri(profile),
      connectionString: connectionProfileUri(profile),
      default_pool_size: null,
      max_client_conn: null,
      is_using_scram_auth: true,
    }))
}
