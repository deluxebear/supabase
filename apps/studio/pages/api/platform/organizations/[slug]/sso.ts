// [self-platform] SSO config stub (M3.1): self-platform has no SSO provider.
// The frontend (sso-config-query.ts) special-cases a 404 whose message
// contains 'Failed to find an existing SSO Provider' as "SSO not set up" and
// renders normally — fetchers.ts attaches code = HTTP status automatically.
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, _claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  return res
    .status(404)
    .json({ message: 'Failed to find an existing SSO Provider for this organization' })
}
