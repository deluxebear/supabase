// [self-platform] Executes SQL against the platform metadata db via the
// existing pg-meta service (same x-connection-encrypted mechanism as
// lib/api/self-hosted/query.ts, different connection target).
import { constructHeaders } from '../apiHelpers'
import { encryptString } from '../self-hosted/util'
import {
  PLATFORM_POSTGRES_DB,
  PLATFORM_POSTGRES_HOST,
  PLATFORM_POSTGRES_PASSWORD,
  PLATFORM_POSTGRES_PORT,
  PLATFORM_POSTGRES_USER,
} from './constants'
import { PG_META_URL } from '@/lib/constants/index'

export function getPlatformConnectionString(): string {
  return `postgresql://${PLATFORM_POSTGRES_USER}:${PLATFORM_POSTGRES_PASSWORD}@${PLATFORM_POSTGRES_HOST}:${PLATFORM_POSTGRES_PORT}/${PLATFORM_POSTGRES_DB}`
}

export type PlatformQueryOptions = {
  query: string
  parameters?: unknown[]
}

export async function executePlatformQuery<T = unknown>({
  query,
  parameters,
}: PlatformQueryOptions): Promise<{ data: T[] | undefined; error: Error | undefined }> {
  const connectionStringEncrypted = encryptString(getPlatformConnectionString())

  const requestBody: { query: string; parameters?: unknown[] } = { query }
  if (parameters !== undefined) {
    requestBody.parameters = parameters
  }

  const response = await fetch(`${PG_META_URL}/query`, {
    method: 'POST',
    headers: constructHeaders({
      'Content-Type': 'application/json',
      'x-connection-encrypted': connectionStringEncrypted,
    }),
    body: JSON.stringify(requestBody),
  })

  const result = await response.json()
  if (!response.ok) {
    const message = typeof result?.message === 'string' ? result.message : JSON.stringify(result)
    return { data: undefined, error: new Error(message) }
  }
  return { data: result as T[], error: undefined }
}
