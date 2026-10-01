import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import { Repeat, Split } from 'lucide-react'
import type { PropsWithChildren } from 'react'
import { Badge, cn } from 'ui'

import type { FlowNode } from './Durable.flow'
import type { FlowDiagramNode } from './Durable.flowLayout'
import { WorkflowStatus } from './DurableShared'
import { t as $t } from '@/lib/i18n'

const MERGE_CAPTIONS = { all: 'All branches', first: 'First to finish' } as const
const SELECTED_RING = 'ring-2 ring-foreground-light'

const getStatusAccent = (status?: string | null) => {
  switch (status?.toLowerCase()) {
    case 'completed':
      return 'border-brand-500'
    case 'failed':
      return 'border-destructive-500'
    case 'running':
      return 'border-warning-400'
    case 'skipped':
    case 'cancelled':
      return 'border-dashed opacity-60'
    default:
      return ''
  }
}

const HiddenHandles = () => (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
    <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
  </>
)

const StatusIndicator = ({ status }: { status?: string | null }) => {
  if (!status) return null
  return (
    <span className="flex items-center gap-1 shrink-0">
      {status.toLowerCase() === 'running' && (
        <span className="size-2 rounded-full bg-warning animate-pulse" aria-hidden />
      )}
      <WorkflowStatus status={status} />
    </span>
  )
}

const Summary = ({ flow }: { flow: FlowNode }) => {
  if (flow.isIncomplete) {
    return (
      <p className="text-xs italic text-foreground-muted truncate">{$t('Not configured yet')}</p>
    )
  }
  if (!flow.summary) return null
  return (
    <p className="text-xs font-mono text-foreground-light truncate" title={flow.summary}>
      {flow.summary}
    </p>
  )
}

const CardShell = ({
  selected,
  status,
  isDashed = false,
  children,
}: PropsWithChildren<{ selected: boolean; status?: string | null; isDashed?: boolean }>) => (
  <div
    className={cn(
      'h-full w-full rounded-md border bg-surface-100 px-3 py-2 flex flex-col justify-center gap-1',
      getStatusAccent(status),
      isDashed && 'border-dashed',
      selected && SELECTED_RING
    )}
  >
    <HiddenHandles />
    {children}
  </div>
)

const StepNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => {
  const { flow } = data
  return (
    <CardShell selected={selected} status={flow.status}>
      <div className="flex items-center gap-2 min-w-0">
        {flow.kind === 'decision' && (
          <Split size={14} className="text-foreground-light shrink-0" aria-hidden />
        )}
        <Badge>{flow.stepType}</Badge>
        <span className="text-xs font-mono truncate" title={flow.title}>
          {flow.title}
        </span>
        <span className="ml-auto">
          <StatusIndicator status={flow.status} />
        </span>
      </div>
      <Summary flow={flow} />
    </CardShell>
  )
}

const UnknownNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => (
  <CardShell selected={selected} isDashed>
    <span className="text-xs text-foreground-muted">{$t('Unknown step')}</span>
    <code className="text-xs text-foreground-muted truncate">{data.flow.title}</code>
  </CardShell>
)

const GatewayNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => {
  const { flow } = data
  const caption = flow.mergeMode ? $t(MERGE_CAPTIONS[flow.mergeMode]) : null
  return (
    <div className={cn('h-full w-full flex flex-col items-center', selected && SELECTED_RING)}>
      <HiddenHandles />
      <div className="h-2 w-full rounded-full bg-foreground-muted" />
      {caption && (
        <span className="text-xs leading-4 text-foreground-light truncate max-w-full">
          {flow.title ? `${flow.title} · ${caption}` : caption}
        </span>
      )}
    </div>
  )
}

const TerminalNode = ({ data }: NodeProps<FlowDiagramNode>) => (
  <div className="h-full w-full rounded-full border bg-surface-200 flex items-center justify-center text-xs text-foreground-light">
    <HiddenHandles />
    {data.flow.kind === 'start' ? $t('Start') : $t('End')}
  </div>
)

const LoopNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => {
  const { flow } = data
  return (
    <div
      className={cn(
        'h-full w-full rounded-md border border-dashed border-strong bg-surface-75',
        getStatusAccent(flow.status),
        selected && SELECTED_RING
      )}
    >
      <HiddenHandles />
      {/* h-14 must match LOOP_HEADER_HEIGHT in Durable.flowLayout.ts */}
      <div className="h-14 px-3 pt-1 min-w-0">
        <div className="h-7 flex items-center gap-2 min-w-0">
          <Repeat size={14} className="text-foreground-light shrink-0" aria-hidden />
          <Badge>{flow.stepType}</Badge>
          <span
            className="flex-1 min-w-0 text-xs font-mono truncate"
            title={flow.summary ?? flow.title}
          >
            {flow.summary ?? flow.title}
          </span>
          <StatusIndicator status={flow.status} />
        </div>
        <div className="flex items-center gap-2 text-xs text-foreground-light">
          {flow.continueOnFailure && <span>{$t('Continue after step failures')}</span>}
          {typeof flow.iteration === 'number' && (
            <span>{$t('Iteration {{number}}', { number: flow.iteration })}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Keys match `FlowNode.kind`, which `layoutFlowGraph` uses as the React Flow node type. */
export const flowNodeTypes: NodeTypes = {
  start: TerminalNode,
  end: TerminalNode,
  step: StepNode,
  decision: StepNode,
  unknown: UnknownNode,
  fork: GatewayNode,
  merge: GatewayNode,
  loop: LoopNode,
}
