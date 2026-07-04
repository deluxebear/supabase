// [self-platform] Dashboard signup: invite-only (M3.2). Public registration
// is off — see the invite-only gate in the handler below. Frontend body was
// { email, password, hcaptchaToken, redirectTo } (data/misc/signup-mutation.ts)
// back when this proxied to GoTrue; that proxy is gone.
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// [self-platform] Public: called pre-login from the sign-up page, before any
// session exists.
export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: false })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Signup is not available on this deployment' })
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  // [self-platform] M3.2: signup is invite-only. Public registration is off
  // (docker-compose.platform.yml GOTRUE_DISABLE_SIGNUP=true is the real gate;
  // this returns a purposeful message instead of GoTrue's generic refusal).
  // The sign-up page/button stays visible (no zero-fork way to hide it for
  // signed-out users) — it now fails with this message.
  return res.status(403).json({
    message:
      'Signups are invite-only on this deployment. Use your invitation email, or ask an organization admin to invite you.',
  })
}
