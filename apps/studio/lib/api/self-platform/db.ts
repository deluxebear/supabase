// [self-platform] Executes server-side SQL directly against the independent
// platform metadata database. Project databases continue to use their own
// pg-meta services; the control plane no longer needs a privileged pg-meta.
import { types as pgTypes, Pool } from 'pg'

import {
  PLATFORM_POSTGRES_DB,
  PLATFORM_POSTGRES_HOST,
  PLATFORM_POSTGRES_PASSWORD,
  PLATFORM_POSTGRES_PORT,
  PLATFORM_POSTGRES_USER,
} from './constants'

// Preserve the JSON wire shapes returned by the previous pg-meta transport.
pgTypes.setTypeParser(pgTypes.builtins.INT8, (value) => Number(value))
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, (value) => new Date(value).toISOString())
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, (value) => new Date(`${value}Z`).toISOString())

declare global {
  // Reuse the pool across Next.js development reloads and server invocations.
  // eslint-disable-next-line no-var
  var selfPlatformPostgresPool: Pool | undefined
}

export function getPlatformConnectionString(): string {
  const url = new URL('postgresql://localhost')
  url.hostname = PLATFORM_POSTGRES_HOST
  url.port = String(PLATFORM_POSTGRES_PORT)
  url.pathname = `/${encodeURIComponent(PLATFORM_POSTGRES_DB)}`
  url.username = PLATFORM_POSTGRES_USER
  url.password = PLATFORM_POSTGRES_PASSWORD
  return url.toString()
}

function getPlatformPool(): Pool {
  if (globalThis.selfPlatformPostgresPool === undefined) {
    globalThis.selfPlatformPostgresPool = new Pool({
      host: PLATFORM_POSTGRES_HOST,
      port: PLATFORM_POSTGRES_PORT,
      database: PLATFORM_POSTGRES_DB,
      user: PLATFORM_POSTGRES_USER,
      password: PLATFORM_POSTGRES_PASSWORD,
      application_name: 'supabase-fleet-studio',
      max: Number(process.env.PLATFORM_POSTGRES_POOL_SIZE ?? 10),
      connectionTimeoutMillis: Number(process.env.PLATFORM_POSTGRES_CONNECT_TIMEOUT_MS ?? 5_000),
      idleTimeoutMillis: Number(process.env.PLATFORM_POSTGRES_IDLE_TIMEOUT_MS ?? 30_000),
      allowExitOnIdle: true,
    })
  }
  return globalThis.selfPlatformPostgresPool
}

export type PlatformQueryOptions = {
  query: string
  parameters?: unknown[]
}

export async function executePlatformQuery<T = unknown>({
  query,
  parameters,
}: PlatformQueryOptions): Promise<{ data: T[] | undefined; error: Error | undefined }> {
  try {
    const result = await getPlatformPool().query(query, parameters)
    return { data: result.rows as T[], error: undefined }
  } catch (error) {
    if (error instanceof Error) {
      return { data: undefined, error }
    }
    throw error
  }
}
