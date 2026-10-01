import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type NodeChange,
  type NodeSelectionChange,
} from '@xyflow/react'
import { Maximize2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useMemo, useState } from 'react'

import '@xyflow/react/dist/style.css'

import { Button, cn, Dialog, DialogContent, DialogHeader, DialogSection, DialogTitle } from 'ui'

import {
  getEdgeAppearance,
  type FlowEdgeLabel,
  type FlowGraph,
  type FlowNode,
} from './Durable.flow'
import { getFlowStructureKey, layoutFlowGraph, type FlowDiagramNode } from './Durable.flowLayout'
import { flowNodeTypes } from './WorkflowFlowNodes'
import { t as $t } from '@/lib/i18n'

type WorkflowFlowDiagramProps = {
  graph: FlowGraph
  /** Height utility for the canvas, e.g. `h-80`. Defaults to `h-[420px]`. */
  className?: string
  selectedNodeId?: string | null
  onSelectNode?: (durableNodeId: string | null) => void
  canExpand?: boolean
}

const MUTED_EDGE_STYLE = { strokeDasharray: '4 4', opacity: 0.5 }

const getEdgeLabelText = (label?: FlowEdgeLabel) => {
  if (label === 'then') return $t('Then')
  if (label === 'else') return $t('Else')
  return undefined
}

const getNodeAriaLabel = (flow: FlowNode) =>
  [flow.stepType, flow.title, flow.status].filter(Boolean).join(', ') || undefined

const FlowCanvas = ({
  graph,
  className,
  selectedNodeId,
  onSelectNode,
  onExpand,
}: Omit<WorkflowFlowDiagramProps, 'canExpand'> & { onExpand?: () => void }) => {
  const { resolvedTheme } = useTheme()
  // Dagre layout is the expensive part; reuse it while the graph object is unchanged.
  const layout = useMemo(() => layoutFlowGraph(graph), [graph])
  const canSelect = onSelectNode !== undefined
  const statusById = new Map(graph.nodes.map((node) => [node.id, node.status]))

  const nodes = layout.nodes.map((node) => ({
    ...node,
    selectable: canSelect && node.selectable,
    // Only selectable steps are tab stops; a preview with nothing to select has none.
    focusable: canSelect && node.selectable,
    selected: !!selectedNodeId && node.data.flow.durableNodeId === selectedNodeId,
    ariaLabel: getNodeAriaLabel(node.data.flow),
  }))
  const edges = layout.edges.map((edge) => {
    const { animated, isMuted } = getEdgeAppearance(graph.mode, statusById.get(edge.target))
    return {
      ...edge,
      animated,
      label: getEdgeLabelText(edge.data?.label),
      style: isMuted ? MUTED_EDGE_STYLE : undefined,
    }
  })

  const durableIdOf = (id: string) =>
    layout.nodes.find((node) => node.id === id)?.data.flow.durableNodeId ?? null

  // Selection changes can arrive in any order within a batch; the newly selected node wins.
  const handleNodesChange = (changes: NodeChange<FlowDiagramNode>[]) => {
    if (!onSelectNode) return
    const selectChanges = changes.filter(
      (change): change is NodeSelectionChange => change.type === 'select'
    )
    const picked = selectChanges.find((change) => change.selected)
    if (picked) {
      onSelectNode(durableIdOf(picked.id))
      return
    }
    if (selectChanges.some((change) => durableIdOf(change.id) === selectedNodeId)) {
      onSelectNode(null)
    }
  }

  return (
    <div
      role="region"
      aria-label={$t('Workflow diagram')}
      className={cn('relative rounded-md border overflow-hidden', className ?? 'h-[420px]')}
    >
      {/* Remount (and refit) only when the structure changes, so status polling keeps the
          user's pan and zoom. */}
      <ReactFlowProvider key={getFlowStructureKey(graph)}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={flowNodeTypes}
          onNodesChange={handleNodesChange}
          onPaneClick={() => onSelectNode?.(null)}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          elementsSelectable={canSelect}
          // The canvas sits inside scrolling sheets: wheel and touch scrolling must reach the
          // sheet, so zooming is left to the controls.
          zoomOnScroll={false}
          preventScrolling={false}
          colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} position="bottom-right" />
          {onExpand && (
            <Panel position="top-right">
              <Button size="tiny" icon={<Maximize2 size={12} />} onClick={onExpand}>
                {$t('Expand')}
              </Button>
            </Panel>
          )}
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}

export const WorkflowFlowDiagram = ({ canExpand = false, ...props }: WorkflowFlowDiagramProps) => {
  const [isExpanded, setIsExpanded] = useState(false)
  return (
    <>
      <FlowCanvas {...props} onExpand={canExpand ? () => setIsExpanded(true) : undefined} />
      {canExpand && (
        <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
          <DialogContent size="xxlarge">
            <DialogHeader>
              <DialogTitle>{$t('Workflow diagram')}</DialogTitle>
            </DialogHeader>
            <DialogSection>
              <FlowCanvas {...props} className="h-[70vh]" />
            </DialogSection>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
