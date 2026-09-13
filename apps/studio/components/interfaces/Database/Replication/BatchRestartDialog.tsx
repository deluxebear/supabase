import { useParams } from 'common'
import { useMemo } from 'react'
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
import { getTableCopyTargets } from './TableSyncCopy.utils'
import { ReplicationPipelineTableStatus } from '@/data/replication/pipeline-replication-status-query'
import { useRollbackTablesMutation } from '@/data/replication/rollback-tables-mutation'
import type { TableSyncCopyConfig } from '@/data/replication/types'
import { t as $t } from '@/lib/i18n'

interface BatchRestartDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'all' | 'errored'
  tables: ReplicationPipelineTableStatus[]
  sourceId?: number
  publicationName?: string
  tableSyncCopy?: TableSyncCopyConfig | null
  pipelineStatusName?: PipelineStatusName
  onRestartStart?: (tableIds: number[]) => void
  onRestartComplete?: (tableIds: number[]) => void
}

export const BatchRestartDialog = ({
  open,
  onOpenChange,
  mode,
  tables,
  sourceId,
  publicationName,
  tableSyncCopy,
  pipelineStatusName,
  onRestartStart,
  onRestartComplete,
}: BatchRestartDialogProps) => {
  const { ref: projectRef, pipelineId: _pipelineId } = useParams()
  const pipelineId = Number(_pipelineId)
  const affectedTables = useMemo(() => {
    if (mode === 'all') {
      return tables
    } else {
      return tables.filter((table) => table.state.name === 'error')
    }
  }, [mode, tables])
  const affectedTableIds = useMemo(() => affectedTables.map((table) => table.id), [affectedTables])

  const copiedTables = useMemo(
    () => getTableCopyTargets(affectedTables, tableSyncCopy),
    [affectedTables, tableSyncCopy]
  )

  const initialSyncDescription =
    copiedTables.length === 0 ? (
      <li>
        <strong>{$t('No table will run an initial sync.')}</strong>{' '}
        {$t(
          'Replication will resume with new changes only, without syncing existing source rows. There is no additional initial sync charge.'
        )}
      </li>
    ) : copiedTables.length === affectedTables.length ? (
      <li>
        <strong>
          {copiedTables.length === 1
            ? 'The table will run its initial sync again.'
            : `All ${copiedTables.length} tables will run initial sync again.`}
        </strong>{' '}
        {$t(
          'Existing source rows will be synced again. Data successfully processed during this initial sync is billed again.'
        )}
      </li>
    ) : (
      <li>
        <strong>
          {copiedTables.length} of {affectedTables.length}{' '}
          {$t('tables will run initial sync again.')}
        </strong>{' '}
        {$t(
          'Existing source rows for those tables will be synced again and billed again. The remaining tables will resume replication with new changes only.'
        )}
      </li>
    )

  const { mutateAsync: rollbackTables, isPending: isResetting } = useRollbackTablesMutation({
    onSuccess: (data) => {
      const count = data.tables.length
      toast.success(
        `Restarting replication for ${count} table${count > 1 ? 's' : ''}. Pipeline will restart automatically.`
      )
    },
    onSettled: () => {
      onRestartComplete?.(affectedTableIds)
      onOpenChange(false)
    },
    onError: (error) => {
      toast.error(`Failed to restart replication: ${error.message}`)
    },
  })

  const handleReset = async () => {
    if (!projectRef) return toast.error($t('Project ref is required'))

    onRestartStart?.(affectedTableIds)

    try {
      await rollbackTables({
        projectRef,
        pipelineId,
        target: mode === 'all' ? { type: 'all_tables' } : { type: 'all_errored_tables' },
        rollbackType: 'full',
        pipelineStatusName,
      })
    } catch (error) {}
  }

  const dialogContent =
    mode === 'all'
      ? {
          title: 'Restart all tables',
          description: (
            <div className="space-y-3 text-sm">
              <p>
                {$t('This will restart replication for all')} {affectedTables.length} table
                {affectedTables.length === 1 ? '' : 's'} {$t('in this pipeline from scratch:')}
              </p>
              <ul className="list-disc list-inside space-y-1.5 pl-2">
                {initialSyncDescription}
                <li>
                  <strong>{$t('All downstream data will be deleted.')}</strong>{' '}
                  {$t('All replicated data will be removed.')}
                </li>
                <li>
                  <strong>{$t('The pipeline will restart automatically.')}</strong>{' '}
                  {$t('This is required to apply this change.')}
                </li>
              </ul>
            </div>
          ),
          action: 'Restart all tables',
        }
      : {
          title: 'Restart failed tables',
          description: (
            <div className="space-y-3 text-sm">
              <p>
                {$t('This will restart replication for all')}{' '}
                <strong>
                  {affectedTables.length} {$t('currently failed tables')}
                </strong>{' '}
                {$t('from scratch:')}
              </p>
              <ul className="list-disc list-inside space-y-1.5 pl-2">
                {initialSyncDescription}
                <li>
                  <strong>{$t('Existing downstream data will be deleted.')}</strong>{' '}
                  {$t('Replicated data for these tables will be removed.')}
                </li>
                <li>
                  <strong>{$t('Tables that are not failed remain untouched.')}</strong>{' '}
                  {$t('The request resets every table that is failed when it runs.')}
                </li>
                <li>
                  <strong>{$t('The pipeline will restart automatically.')}</strong>{' '}
                  {$t('This is required to apply this change.')}
                </li>
              </ul>
            </div>
          ),
          action: 'Restart failed tables',
        }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{dialogContent.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>{dialogContent.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <RestartCostEstimate
          open={open}
          projectRef={projectRef}
          sourceId={sourceId}
          publicationName={publicationName}
          tables={copiedTables}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isResetting}>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={isResetting} onClick={handleReset} variant="warning">
            {isResetting ? 'Restarting replication...' : dialogContent.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
