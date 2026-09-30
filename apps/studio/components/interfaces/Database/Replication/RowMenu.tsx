import { useParams } from 'common'
import {
  ArrowUpCircle,
  CircleStop,
  Edit,
  Eye,
  MoreVertical,
  Play,
  RotateCcw,
  Trash,
} from 'lucide-react'
import Link from 'next/link'
import { parseAsInteger, useQueryState } from 'nuqs'
import { toast } from 'sonner'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  WarningIcon,
} from 'ui'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { getStatusName } from './Pipeline.utils'
import { PipelineStatusName } from './Replication.constants'
import { ReplicationPipelineStatusData } from '@/data/replication/pipeline-status-query'
import { Pipeline } from '@/data/replication/pipelines-query'
import { useRestartPipelineMutation } from '@/data/replication/restart-pipeline-mutation'
import { useStartPipelineMutation } from '@/data/replication/start-pipeline-mutation'
import { useStopPipelineMutation } from '@/data/replication/stop-pipeline-mutation'
import { t as $t } from '@/lib/i18n'
import {
  PipelineStatusRequestStatus,
  usePipelineRequestStatus,
} from '@/state/replication-pipeline-request-status'
import type { ResponseError } from '@/types'

interface RowMenuProps {
  destinationId: number
  pipeline: Pipeline | undefined
  pipelineStatus?: ReplicationPipelineStatusData['status']
  error: ResponseError | null
  isLoading: boolean
  isError: boolean
  hasUpdate?: boolean
  onDeleteClick: () => void
  onUpdateClick?: () => void
}

export const RowMenu = ({
  destinationId,
  pipeline,
  pipelineStatus,
  error,
  isLoading,
  isError,
  hasUpdate = false,
  onDeleteClick,
  onUpdateClick,
}: RowMenuProps) => {
  const { ref: projectRef } = useParams()
  const statusName = getStatusName(pipelineStatus)

  const [, setEdit] = useQueryState(
    'edit',
    parseAsInteger.withOptions({ history: 'push', clearOnDefault: true })
  )

  const { mutateAsync: startPipeline } = useStartPipelineMutation({ onError: () => {} })
  const { mutateAsync: stopPipeline } = useStopPipelineMutation({ onError: () => {} })
  const { mutateAsync: restartPipeline } = useRestartPipelineMutation()
  const { getRequestStatus, isRequestPending, runWithRequestStatus } = usePipelineRequestStatus()
  const requestStatus = pipeline?.id
    ? getRequestStatus(pipeline.id)
    : PipelineStatusRequestStatus.None

  const isPipelineRequestPending = !!pipeline && isRequestPending(pipeline.id)

  // Show actions when not in a transitional state
  const canPerformActions =
    !isError &&
    !!pipeline &&
    !isPipelineRequestPending &&
    requestStatus === PipelineStatusRequestStatus.None &&
    statusName !== PipelineStatusName.STARTING &&
    [PipelineStatusName.STOPPED, PipelineStatusName.STARTED, PipelineStatusName.FAILED].includes(
      statusName as PipelineStatusName
    )

  // Show both stop and restart for started/failed states
  const showStopAndRestart =
    canPerformActions &&
    (statusName === PipelineStatusName.STARTED || statusName === PipelineStatusName.FAILED)

  // Show only start for stopped state
  const showStart = canPerformActions && statusName === PipelineStatusName.STOPPED

  const onEnablePipeline = async () => {
    if (!projectRef) return console.error('Project ref is required')
    if (!pipeline) return toast.error($t('No pipeline found'))

    try {
      await runWithRequestStatus(pipeline.id, PipelineStatusRequestStatus.StartRequested, () =>
        startPipeline({ projectRef, pipelineId: pipeline.id })
      )
    } catch (error) {
      toast.error(
        $t('Failed to start pipeline: {{value0}}', { value0: (error as ResponseError).message })
      )
    }
  }

  const onDisablePipeline = async () => {
    if (!projectRef) return console.error('Project ref is required')
    if (!pipeline) return toast.error($t('No pipeline found'))

    try {
      await runWithRequestStatus(pipeline.id, PipelineStatusRequestStatus.StopRequested, () =>
        stopPipeline({ projectRef, pipelineId: pipeline.id })
      )
    } catch (error) {
      toast.error(
        $t('Failed to stop pipeline: {{value0}}', { value0: (error as ResponseError).message })
      )
    }
  }

  const onRestartPipeline = async () => {
    if (!projectRef) return console.error('Project ref is required')
    if (!pipeline) return toast.error($t('No pipeline found'))

    try {
      await runWithRequestStatus(pipeline.id, PipelineStatusRequestStatus.StopRequested, () =>
        restartPipeline({ projectRef, pipelineId: pipeline.id })
      )
    } catch (error) {
      toast.error(
        $t('Failed to restart pipeline: {{value0}}', { value0: (error as ResponseError).message })
      )
    }
  }

  return (
    <div className="flex justify-end items-center space-x-2">
      {isLoading && <ShimmeringLoader />}

      {isError && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center" tabIndex={0}>
              <WarningIcon />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {$t("Couldn't load status")}
            {error?.message ? `: ${error.message}` : '.'}
          </TooltipContent>
        </Tooltip>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div className="relative">
            <Button
              variant="default"
              className="w-6.5 hit-area-1"
              aria-label={
                hasUpdate ? $t('Pipeline options, update available') : $t('Pipeline options')
              }
              icon={<MoreVertical />}
            />
            {hasUpdate && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary-bright"
                aria-hidden
              />
            )}
          </div>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="bottom" align="end" className="w-44">
          <DropdownMenuItem className="space-x-2" asChild disabled={!pipeline}>
            <Link href={`/project/${projectRef}/database/pipelines/${pipeline?.id}`}>
              <Eye size={14} />
              <p>{$t('View details')}</p>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {hasUpdate && (
            <>
              <DropdownMenuItem
                className="gap-x-2"
                onClick={() => onUpdateClick?.()}
                disabled={isPipelineRequestPending}
              >
                <ArrowUpCircle size={14} />
                <p>{$t('Update available')}</p>
                <span
                  className="ml-auto h-2 w-2 shrink-0 rounded-full bg-primary-bright"
                  aria-hidden
                />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {showStart && (
            <>
              <DropdownMenuItem className="space-x-2" onClick={onEnablePipeline}>
                <Play size={14} />
                <p>{$t('Start pipeline')}</p>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {showStopAndRestart && (
            <>
              <DropdownMenuItem className="space-x-2" onClick={onRestartPipeline}>
                <RotateCcw size={14} />
                <p>{$t('Restart pipeline')}</p>
              </DropdownMenuItem>
              <DropdownMenuItem className="space-x-2" onClick={onDisablePipeline}>
                <CircleStop size={14} />
                <p>{$t('Stop pipeline')}</p>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuItem
            className="space-x-2"
            onClick={() => setEdit(destinationId)}
            disabled={isPipelineRequestPending}
          >
            <Edit size={14} />
            <p>{$t('Edit pipeline')}</p>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="space-x-2"
            onClick={onDeleteClick}
            disabled={isPipelineRequestPending}
          >
            <Trash size={14} />
            <p>{$t('Delete pipeline')}</p>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
