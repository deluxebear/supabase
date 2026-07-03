// [self-platform] M3.0: real role -> AccessControlPermission expansion
// (replaces the M1 transitional org-wide wildcard grant; spec §6).
// Zero-role members get [] — fail closed until a role is assigned.
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { expandPermissions } from '@/lib/api/self-platform/rbac/expand'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type AccessControlPermission = components['schemas']['AccessControlPermission']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

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

  const gotrueId = claims?.sub
  if (!gotrueId) {
    return res.status(401).json({ message: 'Unauthorized: missing token claims' })
  }

  const ctx = await getMemberContext(gotrueId)
  const permissions: AccessControlPermission[] = expandPermissions(ctx)
  return res.status(200).json(permissions)
}
