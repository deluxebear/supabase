import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Badge, Button, Card, CardContent } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { AlertError } from '@/components/ui/AlertError'
import {
  operatorBackupsQueryOptions,
  operatorPITRQueryOptions,
} from '@/data/backup-operator/backup-operator-query'
import { t as $t } from '@/lib/i18n'

interface SelfPlatformPITRProps {
  projectRef?: string
}

export function SelfPlatformPITR({ projectRef }: SelfPlatformPITRProps) {
  const pitrQuery = useQuery(operatorPITRQueryOptions({ projectRef }))
  const backupsQuery = useQuery(operatorBackupsQueryOptions({ projectRef }))

  if (pitrQuery.isPending || backupsQuery.isPending) return <GenericSkeletonLoader />
  if (pitrQuery.isError) {
    return <AlertError error={pitrQuery.error} subject={$t('Failed to load PITR status')} />
  }
  if (backupsQuery.isError) {
    return <AlertError error={backupsQuery.error} subject={$t('Failed to load operator backups')} />
  }

  const pitr = pitrQuery.data
  const backupState = backupsQuery.data
  const blockers = [...pitr.blockers, ...backupState.blockers]

  if (!pitr.enabled) {
    return (
      <Admonition
        type="default"
        title={$t('Point-in-time recovery is not configured')}
        description={$t(
          'Ask your operator to enable pgBackRest WAL archiving to expose a recovery window here.'
        )}
      />
    )
  }

  if (!pitr.healthy || blockers.length > 0 || backupState.isStale) {
    return (
      <Admonition
        type="warning"
        title={$t('Point-in-time recovery is blocked')}
        description={
          blockers.length > 0
            ? blockers.map((blocker) => $t(blocker)).join(' ')
            : $t(
                'The Operator has not published a recent repository observation. Restore planning remains blocked until fresh evidence is available.'
              )
        }
      />
    )
  }

  const formatRecoveryTime = (value: string | null) =>
    value === null ? $t('Not available') : new Date(value).toLocaleString()

  return (
    <Card>
      <CardContent className="space-y-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-medium">{$t('Point-in-time recovery')}</h3>
            <p className="text-sm text-foreground-light">
              {$t('The Backup Operator is continuously archiving WAL for this database instance.')}
            </p>
          </div>
          <Badge variant="success">{$t('Healthy')}</Badge>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-sm font-medium">{$t('Repository')}</p>
            <p className="break-all text-sm text-foreground-light">
              {pitr.repositoryId ?? $t('Not available')}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">{$t('Recovery confidence:')}</p>
            <p className="text-sm text-foreground-light">{$t(backupState.confidence)}</p>
          </div>
          <div>
            <p className="text-sm font-medium">{$t('Earliest recoverable time')}</p>
            <p className="text-sm text-foreground-light">
              {formatRecoveryTime(backupState.recoveryWindow.earliest)}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">{$t('Latest recoverable time')}</p>
            <p className="text-sm text-foreground-light">
              {formatRecoveryTime(backupState.recoveryWindow.latest)}
            </p>
          </div>
        </div>

        {projectRef !== undefined && (
          <div className="flex justify-end">
            <Button asChild>
              <Link href={`/project/${projectRef}/database/backups/scheduled`}>
                {$t('Open restore controls')}
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
