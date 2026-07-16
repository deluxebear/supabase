import Link from 'next/link'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import type { BackupOperatorStatus } from '@/lib/api/self-platform/backup-operator-status.shared'
import { t as $t } from '@/lib/i18n'

export function BackupOperatorNotConfigured({
  projectRef,
  status,
}: {
  projectRef?: string
  status: BackupOperatorStatus
}) {
  const blocker = status.capabilities.blockers.join(' ')
  const description = blocker || status.check.message || 'No backup repository has been configured.'

  return (
    <Admonition
      type="default"
      title={$t('Backup Operator is not configured')}
      description={$t(description)}
    >
      {projectRef && (
        <Button asChild type="button">
          <Link href={`/project/${projectRef}/settings/general`}>
            {$t('Open management trust settings')}
          </Link>
        </Button>
      )}
    </Admonition>
  )
}
