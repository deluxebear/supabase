import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'step'
  | 'decision'
  | 'fork'
  | 'merge'
  | 'loop'
  | 'unknown'

export type FlowEdgeLabel = 'then' | 'else'

export type FlowNode = {
  id: string
  kind: FlowNodeKind
  /** Loop group this node is drawn inside. */
  parentId?: string
  stepType?: string
  title: string
  summary?: string
  /** Builder only: a required field is still empty. */
  isIncomplete?: boolean
  status?: string | null
  iteration?: number | null
  mergeMode?: 'all' | 'first'
  continueOnFailure?: boolean
  /** Runtime only: the df node shown when this flow node is selected. */
  durableNodeId?: string
  /** Runtime only: the condition df node of an IF or LOOP, which is not drawn as its own node. */
  conditionNodeId?: string
  conditionStatus?: string | null
}

export type FlowEdge = { id: string; source: string; target: string; label?: FlowEdgeLabel }

export type FlowGraph = { mode: 'runtime' | 'builder'; nodes: FlowNode[]; edges: FlowEdge[] }

export type Segment = { entry: string; exit: string }

export const START_ID = '__start'
export const END_ID = '__end'

export const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

export const asText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export const getStatus = (node: DurableNode) => node.inferred_status ?? node.status

export const createGraphBuilder = () => {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const usedIds = new Set<string>()
  const unique = (base: string) => {
    let id = base
    for (let n = 1; usedIds.has(id); n++) id = `${base}~${n}`
    usedIds.add(id)
    return id
  }
  const addNode = (node: FlowNode) => {
    const id = unique(node.id)
    nodes.push({ ...node, id })
    return id
  }
  const patchNode = (id: string, fields: Partial<FlowNode>) => {
    const target = nodes.find((n) => n.id === id)
    if (target) Object.assign(target, fields)
  }
  const connect = (source: string, target: string, label?: FlowEdgeLabel) => {
    const edge: FlowEdge = { id: unique(`${source}->${target}`), source, target }
    if (label !== undefined) edge.label = label
    edges.push(edge)
  }
  const chain = (segments: Segment[]): Segment | null => {
    if (segments.length === 0) return null
    for (let i = 1; i < segments.length; i++) connect(segments[i - 1].exit, segments[i].entry)
    return { entry: segments[0].entry, exit: segments[segments.length - 1].exit }
  }
  const branches = (forkId: string, mergeId: string, segments: Segment[]) => {
    for (const segment of segments) {
      connect(forkId, segment.entry)
      connect(segment.exit, mergeId)
    }
  }
  const arm = (
    decisionId: string,
    mergeId: string,
    segment: Segment | null,
    label: FlowEdgeLabel
  ) => {
    if (!segment) {
      connect(decisionId, mergeId, label)
      return
    }
    connect(decisionId, segment.entry, label)
    connect(segment.exit, mergeId)
  }
  const close = (start: string, body: Segment | null, end: string) => {
    if (!body) {
      connect(start, end)
      return
    }
    connect(start, body.entry)
    connect(body.exit, end)
  }
  return { nodes, edges, addNode, patchNode, connect, chain, branches, arm, close }
}

export const single = (id: string): Segment => ({ entry: id, exit: id })

const RAN_STATUSES = new Set(['completed', 'failed', 'running'])

export function getEdgeAppearance(
  mode: FlowGraph['mode'],
  targetStatus: string | null | undefined
): { animated: boolean; isMuted: boolean } {
  if (mode === 'builder') return { animated: false, isMuted: false }
  const status = targetStatus?.toLowerCase() ?? ''
  return { animated: status === 'running', isMuted: !RAN_STATUSES.has(status) }
}

export function getFirstFailedNodeId(graph: FlowGraph | null): string | null {
  if (!graph) return null
  // A failed IF/LOOP condition is not drawn as its own node; it is shown with its decision.
  const isFailed = (n: FlowNode) =>
    !!n.durableNodeId &&
    (n.status?.toLowerCase() === 'failed' || n.conditionStatus?.toLowerCase() === 'failed')
  const failed =
    graph.nodes.find((n) => n.kind === 'step' && isFailed(n)) ?? graph.nodes.find(isFailed)
  return failed?.durableNodeId ?? null
}
