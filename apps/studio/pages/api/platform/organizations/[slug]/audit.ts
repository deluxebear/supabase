// [self-platform] GET org audit logs (AuditLogsResponse) from platform.audit_events.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { listOrganizationAuditLogs } from '@/lib/api/self-platform/audit-logs'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ message: 'Invalid slug parameter' })
  }
  const start = parseTimestamp(req.query.iso_timestamp_start)
  const end = parseTimestamp(req.query.iso_timestamp_end)
  if (start === null || end === null) {
    return res
      .status(400)
      .json({ message: 'iso_timestamp_start and iso_timestamp_end must be ISO timestamps' })
  }

  const org = await guardOrgRoute(res, claims, {
    slug: String(req.query.slug),
    action: PermissionAction.READ,
    resource: 'organizations',
  })
  if (!org) return

  const response = await listOrganizationAuditLogs({
    orgId: org.orgId,
    organizationSlug: String(req.query.slug),
    start,
    end,
  })
  return res.status(200).json(response)
}
