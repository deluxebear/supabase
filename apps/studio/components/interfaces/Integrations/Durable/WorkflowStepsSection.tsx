import { List, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, ToggleGroup, ToggleGroupItem } from 'ui'

import { getFirstFailedNodeId, treeToFlowGraph } from './Durable.flow'
import type { DurableTreeNode } from './Durable.tree'
import { WorkflowStatus } from './DurableShared'
import { WorkflowFlowDiagram } from './WorkflowFlowDiagram'
import { WorkflowStepDetails } from './WorkflowStepDetails'
import { WorkflowStepTree } from './WorkflowStepTree'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

type StepView = 'graph' | 'list'

export const WorkflowStepsSection = ({
  tree,
  nodes,
  instanceStatus,
}: {
  tree: DurableTreeNode | null
  nodes: DurableNode[]
  instanceStatus?: string | null
}) => {
  const [view, setView] = useState<StepView>('graph')
  // null until the user picks a step, so a failed step can be preselected.
  const [selection, setSelection] = useState<{ nodeId: string | null } | null>(null)
  // Stable graph identity lets the diagram reuse its layout across unrelated re-renders.
  const graph = useMemo(() => (tree ? treeToFlowGraph(tree) : null), [tree])
  const failedNodeId =
    instanceStatus?.toLowerCase() === 'failed' ? getFirstFailedNodeId(graph) : null
  const selectedNodeId = selection ? selection.nodeId : failedNodeId
  const selectedNode = nodes.find((node) => node.node_id === selectedNodeId)

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h4>{$t('Steps')}</h4>
        {graph && (
          <ToggleGroup
            type="single"
            size="sm"
            value={view}
            onValueChange={(value) => {
              if (value === 'graph' || value === 'list') setView(value)
            }}
          >
            <ToggleGroupItem value="graph" className="gap-1 px-2">
              <Workflow size={14} aria-hidden />
              <span className="text-xs">{$t('Graph')}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="list" className="gap-1 px-2">
              <List size={14} aria-hidden />
              <span className="text-xs">{$t('List')}</span>
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      <p className="text-xs text-foreground-light">
        {$t(
          'Step status reflects the current execution, including steps waiting for timers or signals.'
        )}
      </p>
      {graph && view === 'graph' && (
        <>
          <WorkflowFlowDiagram
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelectNode={(nodeId) => setSelection({ nodeId })}
            canExpand
          />
          {selectedNode ? (
            <div className="border rounded-md bg-surface-100 p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{selectedNode.node_type}</Badge>
                <span className="text-xs font-mono">
                  {selectedNode.result_name || selectedNode.node_id}
                </span>
                <span className="ml-auto">
                  <WorkflowStatus status={selectedNode.inferred_status ?? selectedNode.status} />
                </span>
              </div>
              <WorkflowStepDetails node={selectedNode} />
            </div>
          ) : (
            <p className="text-xs text-foreground-light">
              {$t('Select a step to see its details.')}
            </p>
          )}
        </>
      )}
      {tree && view === 'list' && <WorkflowStepTree root={tree} />}
      {nodes.length === 0 && (
        <p className="text-xs text-foreground-light">{$t('No steps available yet')}</p>
      )}
    </>
  )
}
