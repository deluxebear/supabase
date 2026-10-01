import type { FlowGraph } from './Durable.flow'
import { treeToFlowGraph } from './Durable.flowRuntime'
import { buildNodeTree } from './Durable.tree'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

export const durableNode = (
  overrides: Partial<DurableNode> & { node_id: string }
): DurableNode => ({
  node_type: 'SQL',
  query: null,
  result_name: null,
  left_node: null,
  right_node: null,
  status: null,
  result: null,
  status_details: null,
  inferred_status: null,
  updated_at: null,
  ...overrides,
})

export const runtimeGraph = (rootId: string, nodes: DurableNode[]) => {
  const tree = buildNodeTree(rootId, nodes)
  if (!tree) throw new Error('empty tree')
  return treeToFlowGraph(tree)
}

export const byId = (graph: FlowGraph, id: string) => {
  const found = graph.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

export const edgePairs = (graph: FlowGraph) =>
  graph.edges.map((e) => `${e.source}->${e.target}${e.label ? `:${e.label}` : ''}`)
