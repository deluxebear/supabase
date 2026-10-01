import dagre from '@dagrejs/dagre'
import { MarkerType, Position, type Edge, type Node } from '@xyflow/react'

import type { FlowEdgeLabel, FlowGraph, FlowNode, FlowNodeKind } from './Durable.flow'

type Box = { width: number; height: number }
type Placed = Box & { x: number; y: number }

export const FLOW_NODE_SIZES: Record<Exclude<FlowNodeKind, 'loop'>, Box> = {
  step: { width: 240, height: 64 },
  decision: { width: 240, height: 64 },
  unknown: { width: 240, height: 48 },
  start: { width: 96, height: 32 },
  end: { width: 96, height: 32 },
  fork: { width: 120, height: 8 },
  merge: { width: 160, height: 24 },
}
export const LOOP_PADDING = 16
/** Matches the `h-14` loop header (title row + details row) in `WorkflowFlowNodes.tsx`. */
export const LOOP_HEADER_HEIGHT = 56
const EMPTY_LOOP_BODY: Box = { width: 240, height: 48 }
const NODE_SEP = 32
const RANK_SEP = 40

export type FlowNodeData = { flow: FlowNode }
export type FlowDiagramNode = Node<FlowNodeData>
export type FlowDiagramEdge = Edge<{ label?: FlowEdgeLabel }>

const MAX_CACHED_LAYOUTS = 16
// Node sizes are fixed per kind, so positions depend only on the graph's structure. Caching them
// keeps dagre off the typing path in the builder and off every changed poll of a running workflow.
const placementCache = new Map<string, Map<string, Placed>>()

const rememberPlacement = (key: string, placed: Map<string, Placed>) => {
  placementCache.delete(key)
  placementCache.set(key, placed)
  if (placementCache.size > MAX_CACHED_LAYOUTS) {
    const oldest = placementCache.keys().next().value
    if (oldest !== undefined) placementCache.delete(oldest)
  }
}

/**
 * Lays out a flow graph top to bottom with dagre. Loop groups are laid out bottom-up: each
 * loop's children get their own dagre pass, then the loop is one fixed-size node in its
 * parent's pass. Child positions are relative to their loop, as React Flow expects. Positions
 * are cached by structure; node data always comes from the graph passed in.
 */
export function layoutFlowGraph(graph: FlowGraph): {
  nodes: FlowDiagramNode[]
  edges: FlowDiagramEdge[]
} {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const scopeOf = new Map<string, string | undefined>()
  const childrenOf = new Map<string | undefined, FlowNode[]>()
  for (const node of graph.nodes) {
    const parent = node.parentId !== undefined && ids.has(node.parentId) ? node.parentId : undefined
    scopeOf.set(node.id, parent)
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), node])
  }
  const structureKey = getFlowStructureKey(graph)
  const cachedPlacement = placementCache.get(structureKey)
  const placed = cachedPlacement ?? new Map<string, Placed>()

  const layoutLoop = (loop: FlowNode): Box => {
    const content = layoutScope(loop.id)
    const inner: Box = {
      width: Math.max(content.width, EMPTY_LOOP_BODY.width),
      height: Math.max(content.height, EMPTY_LOOP_BODY.height),
    }
    const offsetX = LOOP_PADDING + (inner.width - content.width) / 2
    const offsetY = LOOP_HEADER_HEIGHT + LOOP_PADDING
    for (const child of childrenOf.get(loop.id) ?? []) {
      const p = placed.get(child.id)
      if (p) placed.set(child.id, { ...p, x: p.x + offsetX, y: p.y + offsetY })
    }
    return {
      width: inner.width + 2 * LOOP_PADDING,
      height: LOOP_HEADER_HEIGHT + inner.height + 2 * LOOP_PADDING,
    }
  }

  function layoutScope(parentId: string | undefined): Box {
    const members = childrenOf.get(parentId) ?? []
    if (members.length === 0) return { width: 0, height: 0 }
    const dg = new dagre.graphlib.Graph()
    dg.setDefaultEdgeLabel(() => ({}))
    dg.setGraph({ rankdir: 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP })
    for (const member of members) {
      const size = member.kind === 'loop' ? layoutLoop(member) : FLOW_NODE_SIZES[member.kind]
      dg.setNode(member.id, { width: size.width, height: size.height })
    }
    for (const edge of graph.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) continue
      if (scopeOf.get(edge.source) !== parentId || scopeOf.get(edge.target) !== parentId) continue
      dg.setEdge(edge.source, edge.target)
    }
    dagre.layout(dg)

    const raw = members.map((member) => {
      const p = dg.node(member.id)
      return {
        id: member.id,
        x: p.x - p.width / 2,
        y: p.y - p.height / 2,
        width: p.width,
        height: p.height,
      }
    })
    const minX = Math.min(...raw.map((r) => r.x))
    const minY = Math.min(...raw.map((r) => r.y))
    const maxX = Math.max(...raw.map((r) => r.x + r.width))
    const maxY = Math.max(...raw.map((r) => r.y + r.height))
    for (const r of raw) {
      placed.set(r.id, { x: r.x - minX, y: r.y - minY, width: r.width, height: r.height })
    }
    return { width: maxX - minX, height: maxY - minY }
  }

  if (cachedPlacement) {
    rememberPlacement(structureKey, cachedPlacement)
  } else {
    layoutScope(undefined)
    rememberPlacement(structureKey, placed)
  }

  // React Flow requires parents to precede their children.
  const nodes: FlowDiagramNode[] = []
  const emit = (parentId: string | undefined) => {
    for (const member of childrenOf.get(parentId) ?? []) {
      const p = placed.get(member.id) ?? { x: 0, y: 0, ...EMPTY_LOOP_BODY }
      nodes.push({
        id: member.id,
        type: member.kind,
        position: { x: p.x, y: p.y },
        width: p.width,
        height: p.height,
        data: { flow: member },
        draggable: false,
        connectable: false,
        selectable: member.durableNodeId !== undefined,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        ...(parentId === undefined ? {} : { parentId, extent: 'parent' as const }),
      })
      if (member.kind === 'loop') emit(member.id)
    }
  }
  emit(undefined)

  const edges: FlowDiagramEdge[] = graph.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: edge.label === undefined ? {} : { label: edge.label },
    }))

  return { nodes, edges }
}

/** Changes only when the drawn structure changes, not on status or summary updates. */
export const getFlowStructureKey = (graph: FlowGraph) =>
  [
    ...graph.nodes.map((n) => `${n.id}:${n.kind}:${n.parentId ?? ''}`),
    ...graph.edges.map((e) => e.id),
  ].join('|')
