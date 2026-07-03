import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getMemberContext, isOrgScopedRole } from '@/lib/api/self-platform/members'
import {
  listOrganizationsForProfile,
  toOrganizationResponse,
} from '@/lib/api/self-platform/organizations'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) return handleLegacyGetAll(req, res)

  const gotrueId = claims?.sub
  if (!gotrueId) {
    return res.status(401).json({ message: 'Unauthorized: missing token claims' })
  }
  const [rows, ctx] = await Promise.all([
    listOrganizationsForProfile(gotrueId),
    getMemberContext(gotrueId),
  ])
  // [self-platform] is_owner is real (M3.0): true only for an org-scoped
  // Owner base role. M3.1 I1 guard: the discriminator is base-role
  // self-reference, NOT an empty project list — an empty derived Owner role
  // must not confer is_owner.
  const ownerOrgIds = new Set(
    ctx.roles
      .filter((role) => role.baseRoleName === 'Owner' && isOrgScopedRole(role))
      .map((role) => role.orgId)
  )
  return res
    .status(200)
    .json(rows.map((row) => toOrganizationResponse(row, ownerOrgIds.has(row.id))))
}

// Plain self-hosted keeps the historical stub payload untouched.
const handleLegacyGetAll = async (_req: NextApiRequest, res: NextApiResponse) => {
  const response = [
    {
      id: 1,
      name: process.env.DEFAULT_ORGANIZATION_NAME || 'Default Organization',
      slug: 'default-org-slug',
      billing_email: 'billing@supabase.co',
      plan: { id: 'enterprise', name: 'Enterprise' },
    },
  ]
  return res.status(200).json(response)
}
