import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { RefreshCw, RotateCcw, Send, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button, Sheet, SheetContent, SheetHeader, SheetSection, SheetTitle } from 'ui'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { reconstructExpression } from './Durable.reconstruct'
import { translateReconstructError } from './Durable.reconstructErrors'
import { buildNodeTree } from './Durable.tree'
import {
  buildCancelWorkflow,
  formatWorkflowValue,
  getWaitingSignalNames,
  isWorkflowActive,
  type WorkflowFormValues,
} from './Durable.utils'
import { WorkflowStatus } from './DurableShared'
import { SendSignalSheet } from './SendSignalSheet'
import { WorkflowStepsSection } from './WorkflowStepsSection'
import { AlertError } from '@/components/ui/AlertError'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { usePgDurableMutation } from '@/data/pg-durable/pg-durable-mutation'
import {
  durableDetailQueryOptions,
  durableExplainQueryOptions,
} from '@/data/pg-durable/pg-durable-query'
import type { DurableConfiguration } from '@/data/pg-durable/pg-durable.types'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

export const WorkflowDetailSheet = ({
  instanceId,
  configuration,
  canWrite,
  canStart,
  onRerun,
  onClose,
}: {
  instanceId: string
  configuration: DurableConfiguration
  canWrite: boolean
  canStart: boolean
  onRerun: (values: Partial<WorkflowFormValues>) => void
  onClose: () => void
}) => {
  const { data: project } = useSelectedProjectQuery()
  const detail = useQuery(
    durableDetailQueryOptions({
      projectRef: project?.ref,
      connectionString: project?.connectionString,
      instanceId,
    })
  )
  const [isPlanOpen, setIsPlanOpen] = useState(false)
  const plan = useQuery(
    durableExplainQueryOptions({
      projectRef: project?.ref,
      connectionString: project?.connectionString,
      input: instanceId,
      enabled: isPlanOpen && configuration.can_explain,
    })
  )
  const { mutate, isPending } = usePgDurableMutation()
  const [isCancelOpen, setIsCancelOpen] = useState(false)
  const [signalName, setSignalName] = useState<string | null>(null)
  const isActive = isWorkflowActive(detail.data?.info?.status)
  const waitingSignals = getWaitingSignalNames(detail.data?.nodes ?? [])
  const canSignal = canWrite && configuration.can_signal && isActive
  const canCancel = canWrite && configuration.can_cancel && isActive
  const handleCancel = () => {
    if (!project?.ref || !canCancel) return
    mutate(
      {
        projectRef: project.ref,
        connectionString: project.connectionString,
        sql: buildCancelWorkflow(instanceId),
      },
      {
        onSuccess: () => {
          toast.success($t('Workflow cancelled'))
          setIsCancelOpen(false)
        },
      }
    )
  }
  const info = detail.data?.info
  const nodes = detail.data?.nodes
  const stepTree = useMemo(
    () => (nodes ? buildNodeTree(info?.root_node ?? null, nodes) : null),
    [info?.root_node, nodes]
  )
  const handleRerun = () => {
    if (!info || !nodes) return
    const result = reconstructExpression(info.root_node ?? null, nodes)
    if ('error' in result) {
      toast.error(
        $t("This workflow can't be re-run: {{reason}}", {
          reason: translateReconstructError(result.error),
        })
      )
      return
    }
    onRerun({
      mode: 'expression',
      expression: result.expression,
      label: info.label ?? '',
      transactionMode: 'caller',
    })
  }
  const formatTimestamp = (value?: string | null) =>
    value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—'
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open && !isPending) onClose()
        }}
      >
        <SheetContent size="lg" className="flex flex-col gap-0">
          <SheetHeader>
            <SheetTitle>{detail.data?.info?.label || $t('Workflow details')}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-auto">
            <SheetSection className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <WorkflowStatus status={detail.data?.info?.status} />
                <span className="font-mono text-xs text-foreground-light break-all">
                  {instanceId}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  icon={<RefreshCw size={14} />}
                  loading={detail.isFetching}
                  onClick={() => {
                    void detail.refetch()
                  }}
                >
                  {$t('Refresh')}
                </Button>
                <ButtonTooltip
                  icon={<Send size={14} />}
                  disabled={!canSignal || isPending}
                  tooltip={{
                    content: {
                      text: !canSignal
                        ? $t('Signals require a running workflow and database write permission.')
                        : undefined,
                    },
                  }}
                  onClick={() => setSignalName(waitingSignals[0] ?? '')}
                >
                  {$t('Send signal')}
                </ButtonTooltip>
                <ButtonTooltip
                  variant="danger"
                  icon={<Square size={14} />}
                  disabled={!canCancel || isPending}
                  tooltip={{
                    content: {
                      text: !canCancel
                        ? $t(
                            'Only pending or running workflows can be cancelled with database write permission.'
                          )
                        : undefined,
                    },
                  }}
                  onClick={() => setIsCancelOpen(true)}
                >
                  {$t('Cancel workflow')}
                </ButtonTooltip>
                <ButtonTooltip
                  icon={<RotateCcw size={14} />}
                  disabled={!canStart || !info || isPending}
                  tooltip={{
                    content: {
                      text: !canStart
                        ? $t(
                            'Workflow creation requires database write permission, pg_durable access, and a configured runtime.'
                          )
                        : undefined,
                    },
                  }}
                  onClick={handleRerun}
                >
                  {$t('Re-run')}
                </ButtonTooltip>
              </div>
              {info && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {[
                    { label: $t('Created'), value: formatTimestamp(info.created_at) },
                    { label: $t('Completed'), value: formatTimestamp(info.completed_at) },
                    { label: $t('Submitted by'), value: info.submitted_by || '—' },
                    { label: $t('Database'), value: info.database || '—' },
                  ].map((item) => (
                    <div key={item.label}>
                      <dt className="text-foreground-light">{item.label}</dt>
                      <dd className="font-mono break-all">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {isActive && (
                <p className="text-xs text-foreground-light">
                  {$t('Live updates every 3 seconds')}
                </p>
              )}
              {waitingSignals.length > 0 && (
                <div className="rounded-md border bg-surface-200 p-4 space-y-2">
                  <h4>{$t('Waiting for signals')}</h4>
                  <div className="flex flex-wrap gap-2">
                    {waitingSignals.map((name) => (
                      <Button
                        key={name}
                        disabled={!canSignal || isPending}
                        onClick={() => setSignalName(name)}
                        icon={<Send size={14} />}
                      >
                        {name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </SheetSection>
            {detail.isPending && (
              <SheetSection>
                <GenericSkeletonLoader />
              </SheetSection>
            )}
            {detail.isError && (
              <SheetSection>
                <AlertError
                  error={detail.error}
                  subject={$t('Failed to retrieve workflow details')}
                />
              </SheetSection>
            )}
            {detail.isSuccess && !detail.data.info && (
              <SheetSection>
                <p className="text-sm text-foreground-light">
                  {$t('This workflow is unavailable or has been removed by retention cleanup.')}
                </p>
              </SheetSection>
            )}
            {detail.isSuccess && detail.data.info && (
              <>
                <SheetSection className="border-t space-y-3">
                  <h4>{$t('Workflow result')}</h4>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-surface-200 rounded-md p-4 max-h-72 overflow-auto">
                    {formatWorkflowValue(detail.data.info.output)}
                  </pre>
                </SheetSection>
                <SheetSection className="border-t space-y-3">
                  <WorkflowStepsSection
                    tree={stepTree}
                    nodes={detail.data.nodes}
                    instanceStatus={detail.data.info.status}
                  />
                </SheetSection>
                {configuration.can_explain && (
                  <SheetSection className="border-t space-y-3">
                    <details onToggle={(event) => setIsPlanOpen(event.currentTarget.open)}>
                      <summary className="cursor-pointer text-sm">{$t('Plan')}</summary>
                      <div className="mt-3 space-y-3">
                        <Button
                          icon={<RefreshCw size={14} />}
                          loading={plan.isFetching}
                          onClick={() => {
                            void plan.refetch()
                          }}
                        >
                          {$t('Refresh plan')}
                        </Button>
                        {plan.isPending && plan.isFetching && <GenericSkeletonLoader />}
                        {plan.isError && (
                          <AlertError
                            error={plan.error}
                            subject={$t('Failed to retrieve workflow plan')}
                          />
                        )}
                        {plan.isSuccess && (
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-surface-200 rounded-md p-4 max-h-72 overflow-auto">
                            {plan.data}
                          </pre>
                        )}
                      </div>
                    </details>
                  </SheetSection>
                )}
                <SheetSection className="border-t space-y-3">
                  <h4>{$t('Execution history')}</h4>
                  <p className="text-xs text-foreground-light">
                    {$t('The 20 most recent executions, including loop iterations.')}
                  </p>
                  {detail.data.executions.map((execution) => (
                    <details key={execution.execution_id} className="border rounded-md p-3">
                      <summary className="cursor-pointer flex flex-wrap items-center gap-2">
                        <span className="text-sm">
                          {$t('Execution {{number}}', { number: execution.execution_id })}
                        </span>
                        <WorkflowStatus status={execution.status} />
                        <span className="text-xs text-foreground-light ml-auto">
                          {execution.event_count} {$t('Events')} · {execution.duration_ms ?? '—'} ms
                        </span>
                      </summary>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-all mt-3 max-h-60 overflow-auto">
                        {formatWorkflowValue(execution.output)}
                      </pre>
                    </details>
                  ))}
                  {detail.data.executions.length === 0 && (
                    <p className="text-xs text-foreground-light">
                      {$t('No executions available yet')}
                    </p>
                  )}
                </SheetSection>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {signalName !== null && (
        <SendSignalSheet
          instanceId={instanceId}
          name={signalName}
          onClose={() => setSignalName(null)}
        />
      )}
      <ConfirmationModal
        visible={isCancelOpen}
        title={$t('Cancel workflow?')}
        confirmLabel={$t('Cancel workflow')}
        confirmLabelLoading={$t('Cancelling workflow')}
        loading={isPending}
        onCancel={() => {
          if (!isPending) setIsCancelOpen(false)
        }}
        onConfirm={handleCancel}
        disabled={!canCancel}
      >
        <p className="text-sm text-foreground-light">
          {$t(
            'Cancellation stops future steps and active child workflows. SQL changes and HTTP requests that have already completed are not undone.'
          )}
        </p>
      </ConfirmationModal>
    </>
  )
}
