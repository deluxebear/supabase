import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import { IS_PLATFORM } from '../constants'
import { IS_SELF_PLATFORM } from '../constants/self-platform'
import { apiAuthenticate } from './apiAuthenticate'
import { ResponseError, ResponseFailure } from '@/types'

export function isResponseOk<T>(response: T | ResponseFailure | undefined): response is T {
  if (response === undefined || response === null) {
    return false
  }

  if (response instanceof ResponseError) {
    return false
  }

  if (typeof response === 'object' && 'error' in response && Boolean(response.error)) {
    return false
  }

  return true
}

// Purpose of this apiWrapper is to function like a global catchall for ANY errors
// It's a safety net as the API service should never drop, nor fail

async function apiWrapper(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    claims?: JwtPayload
  ) => Promise<NextApiResponse | Response | void>,
  options?: { withAuth?: boolean }
): Promise<NextApiResponse | Response | void> {
  try {
    const { withAuth } = options || {}
    let claims: JwtPayload | undefined

    // [self-platform] Default-deny: routes that don't explicitly opt in/out of
    // auth (withAuth left undefined) are auth-required in self-platform mode.
    // Explicit `{ withAuth: true }` / `{ withAuth: false }` always win. This
    // only changes behavior for IS_SELF_PLATFORM — plain self-hosted
    // (IS_PLATFORM false) never reaches apiAuthenticate, and real cloud
    // (IS_PLATFORM && !IS_SELF_PLATFORM) keeps `undefined ?? false` = false,
    // i.e. unchanged.
    const requireAuth = withAuth ?? IS_SELF_PLATFORM

    if (IS_PLATFORM && requireAuth) {
      const response = await apiAuthenticate(req, res)
      if (!isResponseOk(response)) {
        return res.status(401).json({
          error: {
            message: `Unauthorized: ${response.error.message}`,
          },
        })
      }
      claims = response
    }

    return await handler(req, res, claims) // [self-platform] await so async handler rejections hit the catch below
  } catch (error) {
    return res.status(500).json({ error })
  }
}

export { apiWrapper }
export default apiWrapper
