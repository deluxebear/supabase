// [self-platform] M1 transitional RBAC: every authenticated dashboard user
// gets an org-wide wildcard grant on the default org. Replaced in M3 by the
// role -> AccessControlPermission expansion (spec §6).
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getOrganizationBySlug } from '@/lib/api/self-platform/organizations'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type AccessControlPermission = components['schemas']['AccessControlPermission']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  // [self-platform] I2: derive the org from platform.organizations like every
  // other endpoint does, instead of fabricating id 1 / slug 'default'.
  const org = await getOrganizationBySlug('default')
  if (!org) {
    // No seed org — there's nothing to grant a wildcard on. Empty
    // permissions rather than a fabricated id.
    return res.status(200).json([])
  }

  const permissions: AccessControlPermission[] = [
    {
      actions: ['%'],
      condition: null,
      organization_id: org.id,
      organization_slug: org.slug,
      project_ids: [],
      project_refs: [],
      resources: ['%'],
      restrictive: false,
    },
  ]
  return res.status(200).json(permissions)
}
