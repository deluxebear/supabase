// [self-platform] Audit "account login" event. The dashboard fires this
// fire-and-forget on every sign-in (data/misc/audit-login-mutation.ts); the
// contract is a 201 with an empty body (ProfileController_auditAccountLogin).
// M1/M2 keep no dashboard audit log yet, so this acknowledges the event so the
// UI doesn't surface a "Failed to add login event" error. A real audit sink is
// future work.
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  // Contract is 201 with no body.
  return res.status(201).end()
}
