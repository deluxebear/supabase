import { useQuery } from '@tanstack/react-query'
import { useParams } from 'common'
import { Badge, Card, CardContent, SidePanel } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { AlertError } from '@/components/ui/AlertError'
import { backupOperatorStatusQueryOptions } from '@/data/database/backup-operator-status-query'
import type { BackupOperatorStatus } from '@/lib/api/self-platform/backup-operator-status'
import { t as $t } from '@/lib/i18n'
import { useAddonsPagePanel } from '@/state/addons-page'

const formatDate = (value: string | null) =>
  value === null ? $t('Never') : new Date(value).toLocaleString()

const formatValue = (value: string | number | null) =>
  value === null || value === '' ? $t('Not reported') : String(value)

const StatusRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-6 border-b py-3 last:border-b-0">
    <span className="text-sm text-foreground-light">{label}</span>
    <span className="text-right text-sm">{value}</span>
  </div>
)

const StatusBadge = ({ status }: { status: BackupOperatorStatus }) => {
  if (status.policy.enabled && status.capabilities.backup) {
    return <Badge variant="success">{$t('Enabled')}</Badge>
  }
  if (status.configured) {
    return <Badge variant="warning">{$t('Blocked')}</Badge>
  }
  return <Badge variant="default">{$t('Not configured')}</Badge>
}

const SelfHostedPITRStatus = ({ status }: { status: BackupOperatorStatus }) => {
  const blockers = [
    ...status.capabilities.blockers,
    ...(status.compatibility.blocker === null ? [] : [status.compatibility.blocker]),
  ]

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-start justify-between gap-6">
        <p className="text-sm text-foreground-light">
          {$t(
            'Physical backups and WAL archiving are managed by the Backup Operator installed in your environment.'
          )}
        </p>
        <StatusBadge status={status} />
      </div>

      {blockers.length > 0 && (
        <Admonition
          type="warning"
          title={$t('PITR is not ready')}
          description={blockers.join('. ')}
        />
      )}

      <Card>
        <CardContent className="py-2">
          <StatusRow
            label={$t('Policy')}
            value={status.policy.enabled ? $t('Enabled') : $t('Disabled')}
          />
          <StatusRow label={$t('Schedule')} value={formatValue(status.policy.schedule)} />
          <StatusRow
            label={$t('Retention')}
            value={
              status.policy.retentionDays === null
                ? $t('Not reported')
                : `${status.policy.retentionDays} ${$t('days')}`
            }
          />
          <StatusRow label={$t('Backup source')} value={formatValue(status.policy.backupFrom)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-2">
          <StatusRow
            label={$t('Provider')}
            value={`${status.provider.name}${status.provider.version ? ` ${status.provider.version}` : ''}`}
          />
          <StatusRow label={$t('Topology')} value={status.topology.kind} />
          <StatusRow label={$t('Primary')} value={formatValue(status.topology.primary)} />
          <StatusRow label={$t('Standbys')} value={status.topology.standbys} />
          <StatusRow label={$t('Database image')} value={formatValue(status.compatibility.image)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-2">
          <StatusRow label={$t('Repository')} value={formatValue(status.repository.type)} />
          <StatusRow label={$t('Location')} value={formatValue(status.repository.location)} />
          <StatusRow label={$t('Repository check')} value={status.check.status} />
          <StatusRow label={$t('Last checked')} value={formatDate(status.check.checkedAt)} />
          {status.check.message !== null && (
            <StatusRow label={$t('Check message')} value={status.check.message} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-2">
          <StatusRow label={$t('Last job')} value={formatValue(status.lastJob?.type ?? null)} />
          <StatusRow label={$t('Job state')} value={formatValue(status.lastJob?.state ?? null)} />
          <StatusRow
            label={$t('Finished at')}
            value={formatDate(status.lastJob?.finishedAt ?? null)}
          />
          <StatusRow label={$t('Status updated')} value={formatDate(status.updatedAt)} />
        </CardContent>
      </Card>
    </div>
  )
}

export const SelfHostedPITRSidePanel = () => {
  const { ref: projectRef } = useParams()
  const { panel, closePanel } = useAddonsPagePanel()
  const { data, error, isError, isPending } = useQuery(
    backupOperatorStatusQueryOptions({ projectRef })
  )

  return (
    <SidePanel
      hideFooter
      size="xlarge"
      visible={panel === 'pitr'}
      onCancel={closePanel}
      header={<h4>{$t('Point in Time Recovery')}</h4>}
    >
      <SidePanel.Content>
        {isPending && (
          <div className="py-6">
            <GenericSkeletonLoader />
          </div>
        )}
        {isError && (
          <div className="py-6">
            <AlertError
              error={error}
              subject={$t('Failed to retrieve Backup Operator status')}
              hideContactSupport
            />
          </div>
        )}
        {data !== undefined && <SelfHostedPITRStatus status={data} />}
      </SidePanel.Content>
    </SidePanel>
  )
}
