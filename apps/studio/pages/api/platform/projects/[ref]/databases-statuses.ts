// [self-platform] M6.0: self-platform status now reflects the real db probe
// (spec §4, via the shared probe engine) instead of an always-healthy stub —
// same single-database shape as databases.ts, just the status projection.
// Plain self-hosted keeps the M1 static ACTIVE_HEALTHY stub byte-identically.
// Typed against api-types so upstream contract changes surface at compile time.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { probeStackHealth, writeThroughStatus } from '@/lib/api/self-platform/health'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type DatabasesStatusesResponse =
  paths['/platform/projects/{ref}/databases-statuses']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  // [self-platform] M3.0 RBAC guard (spec §7.3), placed before the
  // single-method body (no method switch here). 404-before-403 lives inside
  // guardProjectRoute (resolver-first).
  if (IS_SELF_PLATFORM) {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.READ,
      projectRef: String(req.query.ref),
    })
    if (!ok) return

    // [self-platform] M6.0: status comes from the shared probe engine's db
    // result (spec D3 — project status reflects the db probe only).
    const { results, fresh } = await probeStackHealth(String(req.query.ref))
    if (fresh) await writeThroughStatus(String(req.query.ref), results)
    const db = results.find((r) => r.name === 'db')
    const status = (
      db && db.status !== 'ACTIVE_HEALTHY' ? 'UNHEALTHY' : 'ACTIVE_HEALTHY'
    ) as DatabasesStatusesResponse[number]['status']
    const response: DatabasesStatusesResponse = [{ identifier: 'default', status }]
    return res.status(200).json(response)
  }

  // Plain self-hosted: M1 static stub, unchanged.
  const response: DatabasesStatusesResponse = [{ identifier: 'default', status: 'ACTIVE_HEALTHY' }]
  return res.status(200).json(response)
}
