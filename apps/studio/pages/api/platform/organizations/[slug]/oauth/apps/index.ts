// [self-platform] Contract-minimal stub: self-platform has no third-party
// OAuth app registry (M1) — no apps have ever been published or authorized.
// Typed against api-types so upstream contract changes surface at compile
// time.
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

type OAuthAppsResponse =
  paths['/platform/organizations/{slug}/oauth/apps']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response: OAuthAppsResponse = []
  return res.status(200).json(response)
}
