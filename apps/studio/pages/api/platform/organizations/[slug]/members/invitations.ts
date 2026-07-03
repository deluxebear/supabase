// [self-platform] Contract-minimal stub (M3.2 makes it real): the members
// list query Promise.alls GET members + GET members/invitations
// (organization-members-query.ts) — without this route the whole TeamSettings
// members list fails.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type InvitationResponse = components['schemas']['InvitationResponse']

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
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ message: 'Invalid slug parameter' })
  }

  const org = await guardOrgRoute(res, claims, {
    slug: String(req.query.slug),
    action: PermissionAction.READ,
    resource: 'organizations',
  })
  if (!org) return

  const response: InvitationResponse = { invitations: [] }
  return res.status(200).json(response)
}
