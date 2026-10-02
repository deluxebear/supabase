// [self-platform] Organization audit logs from platform.audit_events, mapped
// onto the platform AuditLogsResponse contract the Audit Logs page renders.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

type AuditLogsResponse = components['schemas']['AuditLogsResponse_Output']
export type AuditLogEntry = AuditLogsResponse['result'][number]

// The Fleet Agent's binding heartbeat is recorded every few seconds under the
// binding creator's identity. It is not something a person did, and would
// otherwise bury every real action, so it is left out of the org audit log.
const EXCLUDED_ACTIONS = ['fleet.management_binding.observe']

// Upper bound per request; the page always asks for a bounded time range.
const MAX_ROWS = 5000

export type AuditEventRow = {
  id: string | number
  actor: string
  project_ref: string
  action: string
  operation_id: string | null
  correlation_id: string
  payload: Record<string, unknown> | null
  created_at: string | Date
  actor_email: string | null
}

export function toAuditLogEntry(row: AuditEventRow, organizationSlug: string): AuditLogEntry {
  return {
    action: {
      name: row.action,
      // Events are recorded by the platform after the action succeeds; there is
      // no originating HTTP request to report a method or route for.
      method: '',
      route: '',
      status: 200,
      metadata: row.payload ?? {},
      params: { operation_id: row.operation_id, correlation_id: row.correlation_id },
    },
    actor: {
      token_type: 'jwt',
      user_id: row.actor,
      email: row.actor_email,
    },
    organization_slug: organizationSlug,
    project_ref: row.project_ref,
    request_id: `audit-${row.id}`,
    // The page divides by 1000 to get milliseconds: the contract is microseconds.
    timestamp: new Date(row.created_at).getTime() * 1000,
  }
}

export async function listOrganizationAuditLogs({
  orgId,
  organizationSlug,
  start,
  end,
}: {
  orgId: number
  organizationSlug: string
  start: string
  end: string
}): Promise<AuditLogsResponse> {
  const { data, error } = await executePlatformQuery<AuditEventRow>({
    query: `select e.id, e.actor, e.project_ref, e.action, e.operation_id, e.correlation_id,
                   e.payload, e.created_at, p.primary_email as actor_email
              from platform.audit_events e
              join platform.projects pr on pr.ref = e.project_ref
              left join platform.profiles p on p.gotrue_id::text = e.actor
             where pr.organization_id = $1
               and e.created_at >= $2 and e.created_at <= $3
               and e.action <> all($4::text[])
             order by e.created_at desc
             limit ${MAX_ROWS}`,
    parameters: [orgId, start, end, EXCLUDED_ACTIONS],
  })
  if (error) throw error
  return {
    result: (data ?? []).map((row) => toAuditLogEntry(row, organizationSlug)),
    // audit_events is never pruned; the page does not read this value.
    retention_period: 0,
  }
}
