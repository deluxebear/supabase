// [self-platform] Organization detail (OrganizationSlugResponse).
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  listOrganizationsForProfile,
  toOrganizationSlugResponse,
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
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ message: 'Invalid slug parameter' })
  }

  const slug = String(req.query.slug)
  const gotrueId = claims?.sub
  if (!gotrueId) {
    return res.status(401).json({ message: 'Unauthorized: missing token claims' })
  }
  // [self-platform] Membership, not roles, gates visibility — a zero-role
  // member still sees their org shell. The membership row IS the org row,
  // so no separate getOrganizationBySlug lookup is needed.
  const memberships = await listOrganizationsForProfile(gotrueId)
  if (!memberships.some((org) => org.slug === slug)) {
    return res.status(404).json({ message: 'Organization not found' })
  }
  const row = memberships.find((org) => org.slug === slug)!
  return res.status(200).json(toOrganizationSlugResponse(row))
}
