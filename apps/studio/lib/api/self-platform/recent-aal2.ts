import type { JwtPayload } from '@supabase/supabase-js'

const RECENT_AAL2_SECONDS = 600

// [self-platform] Disruptive actions (restarts, rollouts) need an AAL2 session
// verified within the last 10 minutes.
export function hasRecentAal2(claims: JwtPayload | undefined, nowSeconds = Date.now() / 1000) {
  return (
    claims?.aal === 'aal2' &&
    typeof claims.iat === 'number' &&
    nowSeconds - claims.iat <= RECENT_AAL2_SECONDS
  )
}
