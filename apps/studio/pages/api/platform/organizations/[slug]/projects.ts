// [self-platform] Org-scoped project list (used by org home + project
// selector). Registry-backed in M2; falls back to the single default
// project when the org has nothing registered (M1 behavior).
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { listOrgProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { parsePaginationParam } from '@/lib/api/self-platform/pagination'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export async function handler(req: NextApiRequest, res: NextApiResponse) {
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
  const limit = parsePaginationParam(req.query.limit, 100)
  const offset = parsePaginationParam(req.query.offset, 0)
  if (limit === null || offset === null) {
    return res.status(400).json({ message: 'Invalid pagination parameters' })
  }
  const slug = String(req.query.slug)
  const result = await listOrgProjectsV2(slug, limit, offset)
  if (!result) return res.status(404).json({ message: 'Organization not found' })

  return res.status(200).json(result)
}
