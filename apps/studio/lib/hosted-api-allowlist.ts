// [self-platform] Local platform API needs its own /api/platform + /api/v1
// routes reachable in platform mode; everything else keeps 404ing.
import { STUDIO_CAPABILITIES } from '@/lib/constants/deployment-profile'
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
  '/scoped-access-token-permissions',
]

// `pathname` must be basePath-relative — Next's `nextUrl.pathname` already is,
// and the TanStack guard strips BASE_PATH before calling. Entries are path
// suffixes, so `endsWith` stays correct regardless.
export function isHostedSupportedApiPath(pathname: string): boolean {
  if (
    (!STUDIO_CAPABILITIES.hostedMarketplaceIntegrations &&
      /^\/api\/platform\/integrations(?:\/|$)/.test(pathname)) ||
    (!STUDIO_CAPABILITIES.hostedBilling &&
      /^\/api\/platform\/organizations\/[^/]+\/billing(?:\/|$)/.test(pathname)) ||
    (!STUDIO_CAPABILITIES.hostedOrganizationUsage &&
      /^\/api\/platform\/organizations\/[^/]+\/usage(?:\/|$)/.test(pathname)) ||
    (!STUDIO_CAPABILITIES.previewBranching &&
      /^\/api\/v1\/projects\/[^/]+\/branches(?:\/|$)/.test(pathname)) ||
    (!STUDIO_CAPABILITIES.etlReplication && pathname.startsWith('/api/platform/replication/')) ||
    (!STUDIO_CAPABILITIES.storageAnalytics &&
      /^\/api\/platform\/storage\/[^/]+\/analytics-buckets(?:\/|$)/.test(pathname)) ||
    (!STUDIO_CAPABILITIES.storageVectors &&
      /^\/api\/platform\/storage\/[^/]+\/vector-buckets(?:\/|$)/.test(pathname)) ||
    (!STUDIO_CAPABILITIES.hostedTelemetry && pathname.startsWith('/api/platform/telemetry/'))
  ) {
    return false
  }

  // [self-platform] Anchor at the start of the (basePath-relative) path so a
  // smuggled path like `/foo/api/v1/x` can't match via a mid-string `.includes`.
  if (
    IS_SELF_PLATFORM &&
    (pathname.startsWith('/api/platform/') || pathname.startsWith('/api/v1/'))
  ) {
    return true
  }

  if (
    !STUDIO_CAPABILITIES.hostedIncidentStatus &&
    ['/incident-status', '/incident-banner', '/status-override'].some((url) =>
      pathname.endsWith(url)
    )
  ) {
    return false
  }

  if (!STUDIO_CAPABILITIES.hostedBilling && pathname.endsWith('/api/integrations/stripe-sync')) {
    return false
  }

  return HOSTED_SUPPORTED_API_URLS.some((url) => pathname.endsWith(url))
}
