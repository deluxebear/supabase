import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { parsePaginationParam } from '@/lib/api/self-platform/pagination'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests.
// Legacy V1 (no Version:2 header, or not self-platform) stays the
// hardcoded [DEFAULT_PROJECT] array, byte-identical to M1. The V2 branch is
// registry-backed as of M2.
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  const wantsV2 = IS_SELF_PLATFORM && req.headers['version'] === '2'
  if (!wantsV2) {
    return res.status(200).json([DEFAULT_PROJECT])
  }

  const limit = parsePaginationParam(req.query.limit, 100, 1000)
  const offset = parsePaginationParam(req.query.offset, 0)
  if (limit === null || offset === null) {
    return res.status(400).json({ message: 'Invalid pagination parameters' })
  }
  const result = await listAllProjectsV2(limit, offset)
  return res.status(200).json(result)
}
