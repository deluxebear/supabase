// [self-platform] Contract-minimal stub: self-platform has no read-replica
// fleet to report statuses for (M1) — same single-database shape as
// databases.ts (also a self-hosted-style implementation), just the status
// projection. Typed against api-types so upstream contract changes surface
// at compile time.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
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
  }

  const response: DatabasesStatusesResponse = [{ identifier: 'default', status: 'ACTIVE_HEALTHY' }]
  return res.status(200).json(response)
}
