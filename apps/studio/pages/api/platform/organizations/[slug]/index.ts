// [self-platform] Organization detail (OrganizationSlugResponse).
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  getOrganizationBySlug,
  toOrganizationSlugResponse,
} from '@/lib/api/self-platform/organizations'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }

  const slug = String(req.query.slug)
  const row = await getOrganizationBySlug(slug)
  if (!row) return res.status(404).json({ message: 'Organization not found' })
  return res.status(200).json(toOrganizationSlugResponse(row))
}
