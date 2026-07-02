// [self-platform] Contract-minimal stub: no feature-flag provider (PostHog)
// is wired up for self-platform (M1) — every flag defaults to "off"/absent.
// Called pre-login (FeatureFlagProvider mounts before auth resolves) and
// again per-project, so this intentionally does NOT require auth, matching
// the contract (no 401/403 responses declared for this operation).
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

type FeatureFlagsResponse =
  paths['/platform/telemetry/feature-flags']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: false })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response: FeatureFlagsResponse = {}
  return res.status(200).json(response)
}
