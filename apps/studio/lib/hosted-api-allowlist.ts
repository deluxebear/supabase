// [self-platform] Local platform API needs its own /api/platform + /api/v1
// routes reachable in platform mode; everything else keeps 404ing.
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// [Joshen] Allowlist of API endpoints supported in hosted (platform) mode.
// Every other /api/* route must 404 in platform mode. Shared by the Next
// middleware (proxy.ts) and the TanStack request middleware (start.ts) so
// the list can't drift between the two frameworks while both run in parallel.
export const HOSTED_SUPPORTED_API_URLS = [
  '/ai/sql/generate-v4',
  '/ai/sql/policy',
  '/ai/feedback/rate',
  '/ai/code/complete',
  '/ai/sql/cron-v2',
  '/ai/sql/title-v2',
  '/ai/sql/filter-v1',
  '/ai/onboarding/design',
  '/ai/feedback/classify',
  '/ai/docs',
  '/ai/sql/parse-client-code',
  '/get-ip-address',
  '/get-utc-time',
  '/get-deployment-commit',
  '/check-cname',
  '/edge-functions/test',
  '/edge-functions/body',
  '/generate-attachment-url',
  '/incident-status',
  '/incident-banner',
  '/status-override',
  '/api/integrations/stripe-sync',
  '/content/graphql',
  '/parse-query',
]

// `pathname` must be basePath-relative — Next's `nextUrl.pathname` already is,
// and the TanStack guard strips BASE_PATH before calling. Entries are path
// suffixes, so `endsWith` stays correct regardless.
export function isHostedSupportedApiPath(pathname: string): boolean {
  // [self-platform] Anchor at the start of the (basePath-relative) path so a
  // smuggled path like `/foo/api/v1/x` can't match via a mid-string `.includes`.
  if (
    IS_SELF_PLATFORM &&
    (pathname.startsWith('/api/platform/') || pathname.startsWith('/api/v1/'))
  ) {
    return true
  }
  return HOSTED_SUPPORTED_API_URLS.some((url) => pathname.endsWith(url))
}
