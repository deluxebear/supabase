import assert from 'node:assert'

import { decodeFunctionLogEnvelope } from './function-log-envelope'
import { WrappedResult } from './types'
import { decodeUnifiedLogEnvelope } from './unified-log-envelope'
import { assertSelfHosted } from './util'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_ANALYTICS_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export type RetrieveAnalyticsDataOptions = {
  name: string
  projectRef: string
  params: Record<string, string | undefined>
}

// [self-platform] M6.2 D6: every server-side Logflare fetch (this module +
// both log-drain routes) carries this timeout — a down/hung Logflare must
// not leave a panel/chart stuck in infinite loading.
export const ANALYTICS_TIMEOUT_MS = 15_000

export type AnalyticsResult = {
  result?: any[]
  error?: {
    message: string
  }
  [key: string]: any
}

// [self-platform] Per-ref Logflare target. A registry hit is authoritative:
// NULL analytics fields mean "not configured" (404), NEVER the global stack.
export class AnalyticsNotConfigured extends Error {
  constructor(ref: string) {
    super(`Analytics is not configured for project: ${ref}`)
    this.name = 'AnalyticsNotConfigured'
  }
}

export type AnalyticsTarget = {
  // Logflare BASE url, no trailing slash, no /api suffix.
  baseUrl: string
  token: string
  // Logflare's ?project= identifier. A registered stack is a vanilla
  // self-hosted deployment that identifies itself as 'default' internally
  // (documented assumption, spec §4.5).
  projectParam: string
}

export async function getAnalyticsTarget(
  ref: string | string[] | undefined
): Promise<AnalyticsTarget> {
  if (IS_SELF_PLATFORM) {
    const conn = await resolveProjectConnection(String(ref))
    if (conn.row) {
      if (!conn.logflareUrl || !conn.logflareToken) throw new AnalyticsNotConfigured(conn.ref)
      return {
        baseUrl: conn.logflareUrl.replace(/\/$/, ''),
        token: conn.logflareToken,
        projectParam: 'default',
      }
    }
  }
  assert(process.env.LOGFLARE_URL, 'LOGFLARE_URL is required')
  assert(process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN, 'LOGFLARE_PRIVATE_ACCESS_TOKEN is required')
  return {
    baseUrl: process.env.LOGFLARE_URL.replace(/\/$/, ''),
    token: process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN,
    projectParam: String(ref),
  }
}

/**
 * Retrieves analytics data from Logflare.
 *
 * _Only call this from server-side self-hosted code._
 */
export async function retrieveAnalyticsData({
  name,
  projectRef,
  params,
}: RetrieveAnalyticsDataOptions): Promise<WrappedResult<AnalyticsResult>> {
  assertSelfHosted()

  let url: URL
  let token: string
  if (IS_SELF_PLATFORM) {
    // [self-platform] Per-ref target; AnalyticsNotConfigured/ProjectNotFound
    // propagate to the route.
    const target = await getAnalyticsTarget(projectRef)
    url = new URL(`${target.baseUrl}/api/endpoints/query/${name}`)
    url.searchParams.set('project', target.projectParam)
    token = target.token
  } else {
    assert(PROJECT_ANALYTICS_URL, 'PROJECT_ANALYTICS_URL is required')
    assert(process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN, 'LOGFLARE_PRIVATE_ACCESS_TOKEN is required')
    url = new URL(`${PROJECT_ANALYTICS_URL}endpoints/query/${name}`)
    url.searchParams.set('project', projectRef)
    token = process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN
  }

  const isPgUnifiedQuery =
    name === 'logs.all' &&
    typeof params.sql === 'string' &&
    params.sql.startsWith('-- self-hosted unified logs')
  if (isPgUnifiedQuery) {
    // PG endpoints cannot sandbox dynamic SQL in Logflare 1.50. The management
    // query API validates read-only SQL and resolves native source columns.
    // Project RBAC has already run; the private token stays server-side.
    url = new URL('/api/query', url.origin)
    url.searchParams.set('pg_sql', params.sql ?? '')
  }

  // Add all other params
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && !isPgUnifiedQuery) {
      url.searchParams.set(key, value)
    }
  })

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
    })

    const result = await response.json()

    if (!response.ok || result?.error) {
      const reportedError =
        typeof result?.error === 'string' ? result.error : result?.error?.message
      const error = new Error(
        reportedError ?? `Failed to retrieve analytics data: ${response.statusText}`
      )
      return { data: undefined, error }
    }

    if (Array.isArray(result?.result)) {
      result.result = result.result.map((row: Record<string, unknown>) =>
        decodeUnifiedLogEnvelope(decodeFunctionLogEnvelope(row, projectRef))
      )
    }
    return { data: result, error: undefined }
  } catch (error) {
    if (error instanceof Error) {
      return { data: undefined, error }
    }
    throw error
  }
}
