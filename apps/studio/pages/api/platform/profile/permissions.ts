// [self-platform] M1 transitional RBAC: every authenticated dashboard user
// gets an org-wide wildcard grant on the default org. Replaced in M3 by the
// role -> AccessControlPermission expansion (spec §6).
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
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

  const permissions: AccessControlPermission[] = [
    {
      actions: ['%'],
      condition: null,
      organization_id: 1,
      organization_slug: 'default',
      project_ids: [],
      project_refs: [],
      resources: ['%'],
      restrictive: false,
    },
  ]
  return res.status(200).json(permissions)
}
