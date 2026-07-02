// [self-platform] Org-scoped project list (used by org home + project
// selector). M1: the single default project; registry-backed in M2.
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
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

  const projects = [
    {
      ...DEFAULT_PROJECT,
      organization_slug: 'default',
      is_branch: false,
      preview_branch_refs: [] as string[],
      databases: [
        {
          identifier: DEFAULT_PROJECT.ref,
          region: DEFAULT_PROJECT.region,
          status: DEFAULT_PROJECT.status,
          type: 'PRIMARY',
        },
      ],
    },
  ]
  return res.status(200).json({
    pagination: {
      count: projects.length,
      limit: Number(req.query.limit ?? 100),
      offset: Number(req.query.offset ?? 0),
    },
    projects,
  })
}
