import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

export type DurableTreeNode = {
  id: string
  role: 'root' | 'step' | 'condition' | 'then' | 'else' | 'body' | 'branch'
  branchIndex?: number
  node: DurableNode | null // null = missing reference
  inLoop: boolean
  children: DurableTreeNode[]
}

type Role = DurableTreeNode['role']

export function getNodeConfig(node: DurableNode): Record<string, unknown> | null {
  if (!node.query) return null
  try {
    const parsed: unknown = JSON.parse(node.query)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

export function parseExecutionGeneration(statusDetails: string | null): number | null {
  if (!statusDetails) return null
  try {
    const parsed: unknown = JSON.parse(statusDetails)
    if (parsed === null || typeof parsed !== 'object') return null
    const executionId = (parsed as Record<string, unknown>).execution_id
    if (typeof executionId !== 'string') return null
    const last = executionId.split('::').pop()
    if (last === undefined || !/^\d+$/.test(last.trim())) return null
    return parseInt(last.trim(), 10)
  } catch {
    return null
  }
}

const asId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

export function findRootId(rootId: string | null | undefined, nodes: DurableNode[]): string | null {
  if (nodes.length === 0) return null
  if (rootId && nodes.some((n) => n.node_id === rootId)) return rootId

  const referenced = new Set<string>()
  for (const n of nodes) {
    if (n.left_node) referenced.add(n.left_node)
    if (n.right_node) referenced.add(n.right_node)
    const config = getNodeConfig(n)
    const condition = asId(config?.condition_node)
    if (condition) referenced.add(condition)
    const extra = config?.extra_nodes
    if (Array.isArray(extra)) {
      for (const e of extra) {
        const id = asId(e)
        if (id) referenced.add(id)
      }
    }
  }
  return nodes.find((n) => !referenced.has(n.node_id))?.node_id ?? null
}

export function buildNodeTree(
  rootId: string | null | undefined,
  nodes: DurableNode[]
): DurableTreeNode | null {
  const resolvedRoot = findRootId(rootId, nodes)
  if (!resolvedRoot) return null

  const byId = new Map<string, DurableNode>()
  for (const n of nodes) if (!byId.has(n.node_id)) byId.set(n.node_id, n)
  const visited = new Set<string>()

  const missing = (id: string, role: Role, inLoop: boolean, branchIndex?: number) => {
    const leaf: DurableTreeNode = { id, role, node: null, inLoop, children: [] }
    if (branchIndex !== undefined) leaf.branchIndex = branchIndex
    return leaf
  }

  // Collect the ordered, flattened steps of a THEN chain (left subtree first, then right).
  const collectSteps = (id: string | null, inLoop: boolean, out: DurableTreeNode[]) => {
    if (!id) return
    const n = byId.get(id)
    if (!n || visited.has(id)) {
      out.push(missing(id, 'step', inLoop))
      return
    }
    if (n.node_type.toUpperCase() === 'THEN') {
      visited.add(id)
      collectSteps(n.left_node, inLoop, out)
      collectSteps(n.right_node, inLoop, out)
      return
    }
    out.push(build(id, 'step', inLoop))
  }

  const build = (
    id: string,
    role: Role,
    inLoop: boolean,
    branchIndex?: number
  ): DurableTreeNode => {
    const n = byId.get(id)
    if (!n || visited.has(id)) return missing(id, role, inLoop, branchIndex)
    visited.add(id)

    const result: DurableTreeNode = { id, role, node: n, inLoop, children: [] }
    if (branchIndex !== undefined) result.branchIndex = branchIndex
    const config = getNodeConfig(n)
    const conditionId = asId(config?.condition_node)
    const child = (childId: string | null, childRole: Role, childInLoop: boolean) =>
      childId ? build(childId, childRole, childInLoop) : null
    const push = (c: DurableTreeNode | null) => {
      if (c) result.children.push(c)
    }

    switch (n.node_type.toUpperCase()) {
      case 'THEN':
        collectSteps(n.left_node, inLoop, result.children)
        collectSteps(n.right_node, inLoop, result.children)
        break
      case 'IF':
        push(child(conditionId, 'condition', inLoop))
        push(child(n.left_node, 'then', inLoop))
        push(child(n.right_node, 'else', inLoop))
        break
      case 'LOOP':
        push(child(n.left_node, 'body', true))
        push(child(conditionId, 'condition', true))
        break
      case 'JOIN':
      case 'RACE': {
        const ids: string[] = []
        if (n.left_node) ids.push(n.left_node)
        if (n.right_node) ids.push(n.right_node)
        if (n.node_type.toUpperCase() === 'JOIN' && Array.isArray(config?.extra_nodes)) {
          for (const e of config.extra_nodes) {
            const extraId = asId(e)
            if (extraId) ids.push(extraId)
          }
        }
        ids.forEach((branchId, i) => result.children.push(build(branchId, 'branch', inLoop, i + 1)))
        break
      }
      default:
        break
    }
    return result
  }

  return build(resolvedRoot, 'root', false)
}
