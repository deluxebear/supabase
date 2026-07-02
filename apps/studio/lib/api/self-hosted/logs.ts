import assert from 'node:assert'
import { LogsService } from '@supabase/mcp-server-supabase/platform'
import { stripIndent } from 'common-tags'

import { WrappedResult } from './types'
import { assertSelfHosted } from './util'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_ANALYTICS_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export type RetrieveAnalyticsDataOptions = {
  name: string
  projectRef: string
  params: Record<string, string | undefined>
}

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

  // Add all other params
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
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
    })

    const result = await response.json()

    if (!response.ok) {
      const error = new Error(
        result?.error?.message ?? `Failed to retrieve analytics data: ${response.statusText}`
      )
      return { data: undefined, error }
    }

    return { data: result, error: undefined }
  } catch (error) {
    if (error instanceof Error) {
      return { data: undefined, error }
    }
    throw error
  }
}

export function getLogQuery(service: LogsService, limit: number = 100): string {
  assertSelfHosted()

  switch (service) {
    case 'api': {
      return stripIndent`
        select id, edge_logs.timestamp, event_message, request.method, request.path, request.search, response.status_code
        from edge_logs
        cross join unnest(metadata) as m
        cross join unnest(m.request) as request
        cross join unnest(m.response) as response
        order by timestamp desc
        limit ${limit};
      `
    }
    case 'branch-action': {
      throw new Error('Branching is only supported in the hosted Supabase platform')
    }
    case 'postgres': {
      return stripIndent`
        select postgres_logs.timestamp, id, event_message, parsed.error_severity, parsed.detail, parsed.hint
        from postgres_logs
        cross join unnest(metadata) as m
        cross join unnest(m.parsed) as parsed
        order by timestamp desc
        limit ${limit};
      `
    }
    case 'edge-function': {
      return stripIndent`
        select id, function_edge_logs.timestamp, event_message
        from function_edge_logs
        order by timestamp desc
        limit ${limit}
      `
    }
    case 'auth': {
      return stripIndent`
        select id, auth_logs.timestamp, event_message, metadata.level, metadata.status, metadata.path, metadata.msg as msg, metadata.error from auth_logs
        cross join unnest(metadata) as metadata
        order by timestamp desc
        limit ${limit};
      `
    }
    case 'storage': {
      return stripIndent`
        select id, storage_logs.timestamp, event_message from storage_logs
        order by timestamp desc
        limit ${limit};
      `
    }
    case 'realtime': {
      return stripIndent`
        select id, realtime_logs.timestamp, event_message from realtime_logs
        order by timestamp desc
        limit ${limit};
      `
    }
    default: {
      throw new Error(`Unsupported log service: ${service}`)
    }
  }
}
