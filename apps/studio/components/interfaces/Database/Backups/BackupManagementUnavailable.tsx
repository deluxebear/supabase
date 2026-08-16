import Link from 'next/link'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'

import type { BackupManagementAvailability } from '@/lib/api/self-platform/backup-management-availability-schema'
import { t as $t } from '@/lib/i18n'

export function BackupManagementUnavailable({
  availability,
  projectRef,
}: {
  availability: BackupManagementAvailability
  projectRef?: string
}) {
  const title =
    availability.state === 'unconfigured'
      ? $t('Backup management is not configured')
      : availability.state === 'incompatible'
        ? $t('Backup management is incompatible')
        : availability.state === 'unauthorized'
          ? $t('Backup management is not allowed')
          : $t('Backup management is offline')
  const description = availability.blockers
    .flatMap((blocker) => [blocker.message, blocker.remediation])
    .filter((value): value is string => Boolean(value))
    .map((value) => $t(value))
    .join(' ')

  return (
    <Admonition
      type={availability.state === 'unconfigured' ? 'default' : 'warning'}
      title={title}
      description={description}
    >
      <div className="flex flex-wrap items-center gap-3">
        {projectRef && (
          <Button asChild type="button">
            <Link href={`/project/${projectRef}/settings/general`}>
              {$t('Open management trust settings')}
            </Link>
          </Button>
        )}
        <span className="font-mono text-xs text-foreground-muted">
          {$t('Reference: {{correlationId}}', { correlationId: availability.correlationId })}
        </span>
      </div>
    </Admonition>
  )
}
