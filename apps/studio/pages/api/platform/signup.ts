// [self-platform] Dashboard signup: proxy to the platform GoTrue /signup.
// Frontend body: { email, password, hcaptchaToken, redirectTo }
// (data/misc/signup-mutation.ts). Captcha is not enforced on self-platform.
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { PLATFORM_GOTRUE_URL } from '@/lib/api/self-platform/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

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

  const { email, password } = req.body ?? {}
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ message: 'email and password are required' })
  }

  const response = await fetch(`${PLATFORM_GOTRUE_URL}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const result = await response.json()

  if (!response.ok) {
    const message =
      typeof result?.msg === 'string'
        ? result.msg
        : typeof result?.message === 'string'
          ? result.message
          : 'Signup failed'
    return res.status(response.status).json({ message })
  }
  return res.status(200).json(result)
}
