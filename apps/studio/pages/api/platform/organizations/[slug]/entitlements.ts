// [self-platform] Contract-minimal stub: self-platform has no plan-based
// feature entitlements (M1) — every feature is either always-on (gated
// elsewhere) or always-off. Typed against api-types so upstream contract
// changes surface at compile time.
// M3.1: plain self-hosted keeps the M1 empty stub; self-platform lights up
// the two features TeamSettings/SecuritySettings gate on.
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type EntitlementsResponse =
  paths['/platform/organizations/{slug}/entitlements']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  // [self-platform] plain self-hosted keeps the M1 empty stub byte-identical.
  if (!IS_SELF_PLATFORM) {
    const response: EntitlementsResponse = { entitlements: [] }
    return res.status(200).json(response)
  }
  // M3.1: light up the two features TeamSettings/SecuritySettings gate on.
  const response: EntitlementsResponse = {
    entitlements: [
      {
        config: { enabled: true },
        feature: { key: 'project_scoped_roles', type: 'boolean' },
        hasAccess: true,
        type: 'boolean',
      },
      {
        config: { enabled: true },
        feature: { key: 'security.enforce_mfa', type: 'boolean' },
        hasAccess: true,
        type: 'boolean',
      },
    ],
  }
  return res.status(200).json(response)
}
