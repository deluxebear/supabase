import * as Sentry from '@sentry/nextjs'

import { constructHeaders } from '../apiHelpers'
import { databaseErrorSchema, PgMetaDatabaseError, WrappedResult } from './types'
import { assertSelfHosted, encryptString, getConnectionString } from './util'
// [self-platform] Per-project DSN resolution for the SQL editor's query path.
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'
import { PG_META_URL } from '@/lib/constants/index'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export type QueryOptions = {
  query: string
  parameters?: unknown[]
  readOnly?: boolean
  headers?: HeadersInit
  // [self-platform] When set (and IS_SELF_PLATFORM), routes the query at the
  // resolved project's DB instead of the global env connection.
  projectRef?: string
}

/**
 * Executes a SQL query against the self-hosted Postgres instance via pg-meta service.
 *
 * _Only call this from server-side self-hosted code._
 */
export async function executeQuery<T = unknown>({
  query,
  parameters,
  readOnly = false,
  headers,
  projectRef,
}: QueryOptions): Promise<WrappedResult<T[]>> {
  assertSelfHosted()

  // [self-platform] Self-platform + a projectRef routes at the resolved
  // project's DSN; otherwise fall back to the M1 global-env connection
  // (plain self-hosted / no-ref path stays byte-identical).
  let connectionStringEncrypted: string
  if (IS_SELF_PLATFORM && projectRef) {
    const conn = await resolveProjectConnection(projectRef)
    connectionStringEncrypted = readOnly ? conn.pgConnReadOnlyEncrypted : conn.pgConnEncrypted
  } else {
    connectionStringEncrypted = encryptString(getConnectionString({ readOnly }))
  }

  const requestBody: { query: string; parameters?: unknown[] } = { query }
  if (parameters !== undefined) {
    requestBody.parameters = parameters
  }

  return await Sentry.startSpan({ name: 'pg-meta.query', op: 'db.query' }, async (span) => {
    const response = await fetch(`${PG_META_URL}/query`, {
      method: 'POST',
      headers: constructHeaders({
        ...headers,
        'Content-Type': 'application/json',
        'x-connection-encrypted': connectionStringEncrypted,
      }),
      body: JSON.stringify(requestBody),
    })

    try {
      const result = await response.json()

      if (!response.ok) {
        const { message, code, formattedError } = databaseErrorSchema.parse(result)
        span.setAttribute('db.error', 1)
        span.setAttribute('db.status_code', response.status)
        const error = new PgMetaDatabaseError(message, code, response.status, formattedError)
        return { data: undefined, error }
      }

      span.setAttribute('db.status_code', response.status)
      return { data: result, error: undefined }
    } catch (error) {
      span.setAttribute('db.error', 1)
      if (error instanceof Error) {
        return { data: undefined, error }
      }
      throw error
    }
  })
}
