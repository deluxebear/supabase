// [self-platform] Contract-minimal stub: self-platform has no read-replica
// fleet to report statuses for (M1) — same single-database shape as
// databases.ts (also a self-hosted-style implementation), just the status
// projection. Typed against api-types so upstream contract changes surface
// at compile time.
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

type DatabasesStatusesResponse =
  paths['/platform/projects/{ref}/databases-statuses']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response: DatabasesStatusesResponse = [{ identifier: 'default', status: 'ACTIVE_HEALTHY' }]
  return res.status(200).json(response)
}
