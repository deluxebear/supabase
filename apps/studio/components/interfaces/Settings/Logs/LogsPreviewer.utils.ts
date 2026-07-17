export function isProjectAnalyticsConfigured({
  isSelfPlatform,
  logflareUrl,
  hasLogflareToken,
}: {
  isSelfPlatform: boolean
  logflareUrl?: string | null
  hasLogflareToken?: boolean
}) {
  return !isSelfPlatform || Boolean(logflareUrl && hasLogflareToken)
}

export function canQueryProjectAnalytics({
  isProjectLoading,
  ...configuration
}: Parameters<typeof isProjectAnalyticsConfigured>[0] & { isProjectLoading: boolean }) {
  return (
    !configuration.isSelfPlatform ||
    (!isProjectLoading && isProjectAnalyticsConfigured(configuration))
  )
}
