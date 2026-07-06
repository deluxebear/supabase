import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
    // [self-platform] M6.3: resident infra-metrics sampler (M6.0 poller slot).
    // Env read directly — instrumentation runs before app constants load.
    if (process.env.NEXT_PUBLIC_SELF_PLATFORM === 'true') {
      const { startMetricsSampler } = await import('./lib/api/self-platform/metrics')
      startMetricsSampler()
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
