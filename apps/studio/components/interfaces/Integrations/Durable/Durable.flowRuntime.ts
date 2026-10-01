import {
  asText,
  createGraphBuilder,
  END_ID,
  firstLine,
  getStatus,
  single,
  START_ID,
  type FlowGraph,
  type Segment,
} from './Durable.flow'
import { getNodeConfig, parseExecutionGeneration, type DurableTreeNode } from './Durable.tree'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

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
        if (thenSegment || elseSegment) {
          g.arm(decision, merge, thenSegment, 'then')
          g.arm(decision, merge, elseSegment, 'else')
        } else {
          g.connect(decision, merge)
        }
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
