import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useParams } from 'common'
import { Download } from 'lucide-react'
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from 'ui'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { InlineLink } from '@/components/ui/InlineLink'
import { useBackupDownloadMutation } from '@/data/database/backup-download-mutation'
import type { DatabaseBackup } from '@/data/database/backups-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { t as $t } from '@/lib/i18n'

interface BackupItemProps {
  index: number
  isHealthy: boolean
  isHighAvailability: boolean
  backup: DatabaseBackup
  onSelectBackup: () => void
}

export const BackupItem = ({
  index,
  isHealthy,
  isHighAvailability,
  backup,
  onSelectBackup,
}: BackupItemProps) => {
  const { ref: projectRef } = useParams()
  const { can: canTriggerScheduledBackups } = useAsyncCheckPermissions(
    PermissionAction.INFRA_EXECUTE,
    'queue_job.restore.prepare'
  )

  const { mutate: downloadBackup, isPending: isDownloading } = useBackupDownloadMutation({
    onSuccess: (res) => {
      const { fileUrl } = res

      // Trigger browser download by create,trigger and remove tempLink
      const tempLink = document.createElement('a')
      tempLink.href = fileUrl
      document.body.appendChild(tempLink)
      tempLink.click()
      document.body.removeChild(tempLink)
    },
  })

  function getTooltipText() {
    if (isHighAvailability) {
      return 'Restoring from a backup is unavailable on High Availability projects'
    } else if (!isHealthy) {
      return 'Cannot be restored as project is not active'
    } else if (!canTriggerScheduledBackups) {
      return 'You need additional permissions to trigger a restore'
    } else {
      return undefined
    }
  }

  const generateSideButtons = (backup: DatabaseBackup) => {
    if (backup.status === 'COMPLETED')
      return (
        <div className="flex space-x-4">
          <ButtonTooltip
            disabled={
              IS_SELF_PLATFORM || !isHealthy || !canTriggerScheduledBackups || isHighAvailability
            }
            onClick={onSelectBackup}
            tooltip={{
              content: {
                side: 'bottom',
                text: IS_SELF_PLATFORM
                  ? 'Restore from Studio is not available on self-hosted. Restore using the pgBackRest CLI runbook.'
                  : getTooltipText(),
              },
            }}
          >
            {$t('Restore')}
          </ButtonTooltip>

          {!backup.isPhysicalBackup && (
            <ButtonTooltip
              icon={<Download />}
              loading={isDownloading}
              disabled={!canTriggerScheduledBackups || isDownloading}
              onClick={() => {
                if (!projectRef) return console.error('Project ref is required')
                downloadBackup({ ref: projectRef, backup })
              }}
              tooltip={{
                content: {
                  side: 'bottom',
                  text: !canTriggerScheduledBackups
                    ? 'You need additional permissions to download backups'
                    : undefined,
                },
              }}
            >
              {$t('Download')}
            </ButtonTooltip>
          )}
        </div>
      )
    return <Badge variant="warning">{$t('Backup In Progress...')}</Badge>
  }

  return (
    <div
      className={`flex h-12 items-center justify-between px-6 ${
        index ? 'border-t border-default' : ''
      }`}
    >
      <div className="flex items-center gap-x-2">
        <TimestampInfo
          displayAs="utc"
          utcTimestamp={backup.inserted_at}
          labelFormat="DD MMM YYYY HH:mm:ss (ZZ)"
          className="text-left text-sm! font-mono tracking-tight"
        />
        <Tooltip>
          <TooltipTrigger>
            <Badge variant="default">
              {backup.isPhysicalBackup ? $t('Physical') : $t('Logical')}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {backup.isPhysicalBackup
              ? $t('File-level backups of your entire database.')
              : $t('SQL-based backups of your entire database.')}{' '}
            <InlineLink href="https://supabase.com/blog/postgresql-physical-logical-backups">
              {$t('Learn more')}
            </InlineLink>
          </TooltipContent>
        </Tooltip>
      </div>
      <div>{generateSideButtons(backup)}</div>
    </div>
  )
}
