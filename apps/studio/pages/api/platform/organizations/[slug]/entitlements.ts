// [self-platform] Contract-minimal stub: self-platform has no plan-based
// feature entitlements (M1) — every feature is either always-on (gated
// elsewhere) or always-off. Typed against api-types so upstream contract
// changes surface at compile time.
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

type EntitlementsResponse =
  paths['/platform/organizations/{slug}/entitlements']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response: EntitlementsResponse = { entitlements: [] }
  return res.status(200).json(response)
}
