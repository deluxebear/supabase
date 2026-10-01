import type { DeepPartialSkipArrayKey } from 'react-hook-form'

import { getNodeConfig, parseExecutionGeneration, type DurableTreeNode } from './Durable.tree'
import type { WorkflowFormValues } from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

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

export type WatchedWorkflowValues = DeepPartialSkipArrayKey<WorkflowFormValues>
type WatchedStep = NonNullable<WatchedWorkflowValues['steps']>[number]
type WatchedLeaf = NonNullable<WatchedStep['body']>[number]

type Segment = { entry: string; exit: string }

const START_ID = '__start'
const END_ID = '__end'

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

const asText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const getStatus = (node: DurableNode) => node.inferred_status ?? node.status

const createGraphBuilder = () => {
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

const single = (id: string): Segment => ({ entry: id, exit: id })

export function getRuntimeSummary(node: DurableNode): string | undefined {
  const config = getNodeConfig(node)
  switch (node.node_type.toUpperCase()) {
    case 'SQL':
      return node.query ? firstLine(node.query) || undefined : undefined
    case 'SLEEP':
      return node.query?.trim() ? `${node.query.trim()}s` : undefined
    case 'SIGNAL': {
      const name = asText(config?.signal_name)
      if (!name) return undefined
      const timeout = asText(config?.timeout_seconds)
      return timeout ? `${name} · ${timeout}s` : name
    }
    case 'WAIT_SCHEDULE':
      return asText(config?.cron_expr)
    case 'HTTP':
    case 'HTTP_MULTIPART': {
      const url = asText(config?.url)
      if (!url) return undefined
      const method = asText(config?.method)
      return method ? `${method} ${url}` : url
    }
    case 'BREAK':
      return asText(config?.break_value)
    default:
      return undefined
  }
}

export function treeToFlowGraph(root: DurableTreeNode): FlowGraph {
  const g = createGraphBuilder()
  const start = g.addNode({ id: START_ID, kind: 'start', title: '' })

  const convert = (tree: DurableTreeNode, parentId: string | undefined): Segment => {
    const scope = parentId === undefined ? {} : { parentId }
    const { node } = tree
    if (!node) return single(g.addNode({ id: tree.id, kind: 'unknown', title: tree.id, ...scope }))

    const status = getStatus(node)
    const title = node.result_name || node.node_id
    const config = getNodeConfig(node)
    const childOf = (role: DurableTreeNode['role']) => tree.children.find((c) => c.role === role)
    const conditionNode = childOf('condition')?.node
    const conditionText = conditionNode?.query
      ? firstLine(conditionNode.query) || undefined
      : undefined
    const condition = conditionNode
      ? { conditionNodeId: conditionNode.node_id, conditionStatus: getStatus(conditionNode) }
      : {}

    switch (node.node_type.toUpperCase()) {
      case 'THEN': {
        const segment = g.chain(tree.children.map((child) => convert(child, parentId)))
        return segment ?? single(g.addNode({ id: tree.id, kind: 'unknown', title, ...scope }))
      }
      case 'IF': {
        const isRows = config?.condition_type === 'result_has_rows'
        const decision = g.addNode({
          id: tree.id,
          kind: 'decision',
          stepType: isRows ? 'IF_ROWS' : 'IF',
          title,
          summary: isRows ? asText(config?.result_name) : conditionText,
          status,
          durableNodeId: node.node_id,
          ...condition,
          ...scope,
        })
        const thenChild = childOf('then')
        const elseChild = childOf('else')
        const thenSegment = thenChild ? convert(thenChild, parentId) : null
        const elseSegment = elseChild ? convert(elseChild, parentId) : null
        const merge = g.addNode({
          id: `${tree.id}:merge`,
          kind: 'merge',
          title: '',
          status,
          ...scope,
        })
        g.arm(decision, merge, thenSegment, 'then')
        g.arm(decision, merge, elseSegment, 'else')
        return { entry: decision, exit: merge }
      }
      case 'LOOP': {
        const loop = g.addNode({
          id: tree.id,
          kind: 'loop',
          stepType: 'LOOP',
          title,
          summary: conditionText,
          continueOnFailure: config?.continue_on_failure === true,
          status,
          durableNodeId: node.node_id,
          ...condition,
          ...scope,
        })
        const body = childOf('body')
        if (body) convert(body, loop)
        const iterations = g.nodes
          .filter((n) => n.parentId === loop)
          .map((n) => n.iteration)
          .filter((n): n is number => typeof n === 'number')
        if (iterations.length > 0) g.patchNode(loop, { iteration: Math.max(...iterations) })
        return single(loop)
      }
      case 'JOIN':
      case 'RACE': {
        const fork = g.addNode({ id: `${tree.id}:fork`, kind: 'fork', title: '', status, ...scope })
        const segments = tree.children
          .filter((c) => c.role === 'branch')
          .map((c) => convert(c, parentId))
        const merge = g.addNode({
          id: `${tree.id}:merge`,
          kind: 'merge',
          title: node.result_name ?? '',
          mergeMode: node.node_type.toUpperCase() === 'RACE' ? 'first' : 'all',
          status,
          durableNodeId: node.node_id,
          ...scope,
        })
        g.branches(fork, merge, segments)
        return { entry: fork, exit: merge }
      }
      default:
        return single(
          g.addNode({
            id: tree.id,
            kind: 'step',
            stepType: node.node_type,
            title,
            summary: getRuntimeSummary(node),
            status,
            iteration: tree.inLoop ? parseExecutionGeneration(node.status_details) : null,
            durableNodeId: node.node_id,
            ...scope,
          })
        )
    }
  }

  const body = convert(root, undefined)
  const end = g.addNode({
    id: END_ID,
    kind: 'end',
    title: '',
    status: root.node ? getStatus(root.node) : null,
  })
  g.close(start, body, end)
  return { mode: 'runtime', nodes: g.nodes, edges: g.edges }
}

const LEAF_NODE_TYPES: Record<string, string> = {
  sql: 'SQL',
  sleep: 'SLEEP',
  signal: 'SIGNAL',
  http: 'HTTP',
  multipart: 'HTTP_MULTIPART',
  schedule: 'WAIT_SCHEDULE',
  break: 'BREAK',
}

type LeafInput = WatchedLeaf | WatchedStep
type LeafSummary = { summary?: string; isIncomplete: boolean }

const trimmed = (value: string | undefined) => value?.trim() ?? ''
const complete = (summary: string): LeafSummary => ({ summary, isIncomplete: false })
const INCOMPLETE: LeafSummary = { isIncomplete: true }

function getLeafSummary(step: LeafInput): LeafSummary {
  switch (step.type) {
    case 'sleep': {
      const seconds = trimmed(step.seconds)
      return seconds ? complete(`${seconds}s`) : INCOMPLETE
    }
    case 'signal': {
      const name = trimmed(step.signal)
      if (!name) return INCOMPLETE
      const seconds = trimmed(step.seconds)
      return complete(step.noTimeout || !seconds ? name : `${name} · ${seconds}s`)
    }
    case 'http':
    case 'multipart': {
      const url = trimmed(step.url)
      return url ? complete(`${step.method ?? 'GET'} ${url}`) : INCOMPLETE
    }
    case 'schedule': {
      const cron = trimmed(step.cron)
      return cron ? complete(cron) : INCOMPLETE
    }
    case 'break': {
      const value = trimmed(step.breakValue)
      return value ? complete(value) : { isIncomplete: false }
    }
    default: {
      const query = firstLine(step.query ?? '')
      return query ? complete(query) : INCOMPLETE
    }
  }
}

export function formToFlowGraph(values: WatchedWorkflowValues): FlowGraph {
  const g = createGraphBuilder()
  const start = g.addNode({ id: START_ID, kind: 'start', title: '' })
  const stepTitle = (step: LeafInput, label: string) =>
    trimmed(step.resultName) || $t('Step {{number}}', { number: label })

  const leaf = (step: LeafInput, id: string, label: string, parentId?: string): Segment =>
    single(
      g.addNode({
        id,
        kind: 'step',
        stepType: LEAF_NODE_TYPES[step.type ?? 'sql'] ?? 'SQL',
        title: stepTitle(step, label),
        ...getLeafSummary(step),
        ...(parentId === undefined ? {} : { parentId }),
      })
    )

  const leaves = (
    steps: WatchedLeaf[] | undefined,
    idPrefix: string,
    label: string,
    offset: number,
    parentId?: string
  ) =>
    (steps ?? []).map((child, j) =>
      leaf(child, `${idPrefix}-${j}`, `${label}.${offset + j + 1}`, parentId)
    )

  const step = (s: WatchedStep, index: number): Segment => {
    const id = `step-${index}`
    const label = String(index + 1)
    const title = stepTitle(s, label)
    switch (s.type) {
      case 'loop': {
        const loop = g.addNode({
          id,
          kind: 'loop',
          stepType: 'LOOP',
          title,
          summary: firstLine(s.condition ?? '') || undefined,
          continueOnFailure: s.continueOnFailure === true,
        })
        g.chain(leaves(s.body, `${id}-body`, label, 0, loop))
        return single(loop)
      }
      case 'if':
      case 'if_rows': {
        const isRows = s.type === 'if_rows'
        const condition = isRows ? trimmed(s.rowsResultName) : firstLine(s.condition ?? '')
        const decision = g.addNode({
          id,
          kind: 'decision',
          stepType: isRows ? 'IF_ROWS' : 'IF',
          title,
          summary: condition || undefined,
          isIncomplete: !condition,
        })
        const thenSteps = leaves(s.then, `${id}-then`, label, 0)
        const elseSteps = leaves(s.else, `${id}-else`, label, thenSteps.length)
        const merge = g.addNode({ id: `${id}:merge`, kind: 'merge', title: '' })
        g.arm(decision, merge, g.chain(thenSteps), 'then')
        g.arm(decision, merge, g.chain(elseSteps), 'else')
        return { entry: decision, exit: merge }
      }
      case 'race':
      case 'parallel': {
        const fork = g.addNode({ id: `${id}:fork`, kind: 'fork', title: '' })
        const bodySteps = leaves(s.body, `${id}-body`, label, 0)
        const merge = g.addNode({
          id: `${id}:merge`,
          kind: 'merge',
          title: trimmed(s.resultName),
          mergeMode: s.type === 'race' ? 'first' : 'all',
        })
        g.branches(fork, merge, bodySteps)
        return { entry: fork, exit: merge }
      }
      default:
        return leaf(s, id, label)
    }
  }

  const segments = (values.steps ?? []).map(step)
  let body: Segment | null
  if (values.composition === 'parallel' && segments.length > 0) {
    const fork = g.addNode({ id: '__root:fork', kind: 'fork', title: '' })
    const merge = g.addNode({ id: '__root:merge', kind: 'merge', title: '', mergeMode: 'all' })
    g.branches(fork, merge, segments)
    body = { entry: fork, exit: merge }
  } else {
    body = g.chain(segments)
  }
  const end = g.addNode({ id: END_ID, kind: 'end', title: '' })
  g.close(start, body, end)
  return { mode: 'builder', nodes: g.nodes, edges: g.edges }
}

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
