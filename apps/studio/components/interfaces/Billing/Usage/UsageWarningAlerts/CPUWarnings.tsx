import { AlertTitle } from '@ui/components/shadcn/ui/alert'
import { AlertCircle } from 'lucide-react'
import Link from 'next/link'
import { Alert, AlertDescription, Button } from 'ui'

import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

interface CPUWarningsProps {
  hasAccessToComputeSizes: boolean
  upgradeUrl: string
  severity?: 'warning' | 'critical' | null
}

export const CPUWarnings = ({
  hasAccessToComputeSizes,
  upgradeUrl,
  severity,
}: CPUWarningsProps) => {
  if (severity === 'warning') {
    return (
      <Alert variant="warning">
        <AlertCircle />
        <AlertTitle>{$t('Your max CPU usage has exceeded 80%')}</AlertTitle>
        <AlertDescription>
          {$t(
            'High CPU usage could result in slower queries, disruption of daily back up routines, and in rare cases, your instance may become unresponsive. If you need more resources, consider upgrading to a larger compute add-on.'
          )}
        </AlertDescription>
        <div className="mt-3 flex items-center space-x-2">
          <Button asChild variant="default">
            <Link href={`${DOCS_URL}/guides/troubleshooting/high-cpu-usage`}>
              {$t('Learn more')}
            </Link>
          </Button>
          <Button asChild variant="warning">
            <Link href={upgradeUrl}>
              {hasAccessToComputeSizes ? 'Change compute add-on' : 'Upgrade project'}
            </Link>
          </Button>
        </div>
      </Alert>
    )
  }

  if (severity === 'critical') {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>{$t('Your max CPU usage has reached 100%')}</AlertTitle>
        <AlertDescription>
          {$t(
            'High CPU usage could result in slower queries, disruption of daily back up routines, and in rare cases, your instance may become unresponsive. If you need more resources, consider upgrading to a larger compute add-on.'
          )}
        </AlertDescription>
        <div className="mt-3 flex items-center space-x-2">
          <Button asChild variant="default">
            <Link href={`${DOCS_URL}/guides/troubleshooting/high-cpu-usage`}>
              {$t('Learn more')}
            </Link>
          </Button>
          <Button asChild variant="danger">
            <Link href={upgradeUrl}>
              {hasAccessToComputeSizes ? 'Change compute add-on' : 'Upgrade project'}
            </Link>
          </Button>
        </div>
      </Alert>
    )
  }

  return null
}
