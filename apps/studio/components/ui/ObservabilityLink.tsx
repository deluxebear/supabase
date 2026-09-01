import Link from 'next/link'

import { useHighAvailability } from '@/hooks/misc/useHighAvailability'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const ObservabilityLink = () => {
  const { isHighAvailability } = useHighAvailability()

  // The Metrics API is not available for High Availability (Multigres) projects
  if (isHighAvailability) return null

  return (
    <div className="flex items-center justify-center gap-1.5 text-sm">
      <p className="text-foreground-light">
        {$t('Export Metrics to your dashboards.')}{' '}
        <Link
          href={`${DOCS_URL}/guides/telemetry/metrics`}
          className="text-foreground underline underline-offset-2 decoration-foreground-muted hover:decoration-foreground transition-all"
          target="_blank"
        >
          {$t('Get started for free!')}
        </Link>
      </p>
    </div>
  )
}
