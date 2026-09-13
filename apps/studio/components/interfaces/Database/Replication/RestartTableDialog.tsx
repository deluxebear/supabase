import { useParams } from 'common'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'ui'

import { PipelineStatusName } from './Replication.constants'
import { RestartCostEstimate } from './RestartCostEstimate'
import { shouldCopyTable, type ReplicationTableIdentity } from './TableSyncCopy.utils'
import { useRollbackTablesMutation } from '@/data/replication/rollback-tables-mutation'
import type { TableSyncCopyConfig } from '@/data/replication/types'
import { t as $t } from '@/lib/i18n'

interface RestartTableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  table: ReplicationTableIdentity
  tableSyncCopy?: TableSyncCopyConfig | null
  sourceId?: number
  publicationName?: string
  pipelineStatusName?: PipelineStatusName
  onRestartStart?: () => void
  onRestartComplete?: () => void
}

export const RestartTableDialog = ({
  open,
  onOpenChange,
  table,
  tableSyncCopy,
  sourceId,
  publicationName,
  pipelineStatusName,
  onRestartStart,
  onRestartComplete,
}: RestartTableDialogProps) => {
  const { ref: projectRef, pipelineId: _pipelineId } = useParams()
  const pipelineId = Number(_pipelineId)
  const tableName = `${table.schema}.${table.name}`
  const willCopyTable = shouldCopyTable(tableSyncCopy, table.id)

  const { mutate: rollbackTables, isPending: isResetting } = useRollbackTablesMutation({
    onSuccess: () => {
      toast.success(
        `Restarting replication for "${tableName}". Pipeline will ${pipelineStatusName === PipelineStatusName.STOPPED ? 'start' : 'restart'} automatically.`
      )
    },
    onSettled: () => {
      onRestartComplete?.()
      onOpenChange(false)
    },
    onError: (error) => {
      toast.error(`Failed to restart replication: ${error.message}`)
    },
  })

  const handleReset = () => {
    if (!projectRef) return toast.error($t('Project ref is required'))
    if (!pipelineId) return toast.error($t('Pipeline ID is required'))

    onRestartStart?.()
    rollbackTables({
      projectRef,
      pipelineId,
      target: { type: 'single_table', table_id: table.id },
      rollbackType: 'full',
      pipelineStatusName,
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {$t('Restart replication for')} <code className="text-code-inline">{tableName}</code>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                {$t('This will restart replication for')}{' '}
                <code className="text-code-inline">{tableName}</code> {$t('from scratch:')}
              </p>
              <ul className="list-disc list-inside space-y-1.5 pl-2">
                {willCopyTable ? (
                  <li>
                    <strong>{$t("The table's initial sync will restart.")}</strong>{' '}
                    {$t(
                      'Existing source rows will be synced again. Data successfully processed during this initial sync is billed again.'
                    )}
                  </li>
                ) : (
                  <li>
                    <strong>{$t('The table will skip initial sync.')}</strong>{' '}
                    {$t(
                      'Replication will resume with new changes only, without syncing existing source rows. There is no additional initial sync charge.'
                    )}
                  </li>
                )}
                <li>
                  <strong>{$t('Existing downstream data will be deleted.')}</strong>{' '}
                  {$t('Any replicated data for this table will be removed.')}
                </li>
                <li>
                  <strong>{$t('All other tables remain untouched.')}</strong>{' '}
                  {$t('Only this table is affected.')}
                </li>
                <li>
                  <strong>{$t('The pipeline will restart automatically.')}</strong>{' '}
                  {$t('This is required to apply this change.')}
                </li>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RestartCostEstimate
          open={open}
          projectRef={projectRef}
          sourceId={sourceId}
          publicationName={publicationName}
          tables={willCopyTable ? [table] : []}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isResetting}>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={isResetting} onClick={handleReset} variant="warning">
            {isResetting ? 'Restarting replication...' : 'Restart replication'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
