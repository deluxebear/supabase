import { literal, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'

import { findRootId, getNodeConfig } from './Durable.tree'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

export type ReconstructResult = { expression: string } | { error: string }

class ReconstructError extends Error {}

const fail = (message: string): never => {
  throw new ReconstructError(message)
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const jsonb = (value: unknown): SafeSqlFragment => safeSql`${literal(JSON.stringify(value))}::jsonb`

/**
 * Rebuilds the `df.*` expression that produced a stored workflow graph so it can be re-run.
 * Never throws; unsupported or malformed graphs return `{ error }` with a plain English reason.
 */
export function reconstructExpression(
  rootId: string | null | undefined,
  nodes: DurableNode[]
): ReconstructResult {
  try {
    const resolvedRoot = findRootId(rootId, nodes)
    if (!resolvedRoot) return { error: 'The workflow has no steps' }

    const byId = new Map<string, DurableNode>()
    for (const n of nodes) if (!byId.has(n.node_id)) byId.set(n.node_id, n)

    const lookup = (id: string): DurableNode => byId.get(id) ?? fail(`Step ${id} is missing`)

    const wrap = (node: DurableNode, expression: SafeSqlFragment): SafeSqlFragment =>
      node.result_name ? safeSql`df.as(${expression}, ${literal(node.result_name)})` : expression

    const requireConfig = (node: DurableNode): Record<string, unknown> =>
      getNodeConfig(node) ?? fail(`Step ${node.node_id} has an invalid configuration`)

    const requireChild = (node: DurableNode, id: string | null, label: string): string =>
      id ?? fail(`Step ${node.node_id} is missing its ${label} step`)

    const visiting = new Set<string>()

    const enter = (id: string): DurableNode => {
      if (visiting.has(id)) return fail('The workflow graph contains a cycle')
      const node = lookup(id)
      visiting.add(id)
      return node
    }

    const emit = (id: string): SafeSqlFragment => {
      const node = enter(id)
      let result: SafeSqlFragment
      if (node.node_type.toUpperCase() === 'THEN') result = emitThenChain(node)
      else result = emitNode(node)
      visiting.delete(id)
      return result
    }

    // THEN chains are emitted with an explicit stack so depth does not grow with chain length.
    // `start` has already been entered (added to `visiting`).
    const emitThenChain = (start: DurableNode): SafeSqlFragment => {
      type Frame = {
        node: DurableNode
        phase: 'left' | 'afterLeft' | 'right' | 'afterRight'
        left?: SafeSqlFragment
        right?: SafeSqlFragment
      }
      const isThen = (n: DurableNode) => n.node_type.toUpperCase() === 'THEN'
      const stack: Frame[] = [{ node: start, phase: 'left' }]
      let returned: SafeSqlFragment | undefined

      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        const { node } = frame
        switch (frame.phase) {
          case 'left': {
            const childId = requireChild(node, node.left_node, 'left')
            const child = enter(childId)
            if (isThen(child)) {
              frame.phase = 'afterLeft'
              stack.push({ node: child, phase: 'left' })
            } else {
              frame.left = emitNode(child)
              visiting.delete(childId)
              frame.phase = 'right'
            }
            break
          }
          case 'afterLeft':
            frame.left = returned
            returned = undefined
            frame.phase = 'right'
            break
          case 'right': {
            const childId = requireChild(node, node.right_node, 'right')
            const child = enter(childId)
            if (isThen(child)) {
              frame.phase = 'afterRight'
              stack.push({ node: child, phase: 'left' })
            } else {
              frame.right = emitNode(child)
              visiting.delete(childId)
              frame.phase = 'afterRight'
            }
            break
          }
          case 'afterRight': {
            if (returned !== undefined) {
              frame.right = returned
              returned = undefined
            }
            const combined = wrap(
              node,
              safeSql`df.seq(${frame.left as SafeSqlFragment}, ${frame.right as SafeSqlFragment})`
            )
            visiting.delete(node.node_id)
            stack.pop()
            returned = combined
            break
          }
        }
      }
      return returned ?? fail('The workflow has no steps')
    }

    const emitNode = (node: DurableNode): SafeSqlFragment => {
      const type = node.node_type.toUpperCase()
      switch (type) {
        case 'SQL': {
          if (!isString(node.query) || node.query.length === 0)
            return fail(`Step ${node.node_id} has no SQL`)
          return wrap(node, safeSql`df.sql(${literal(node.query)})`)
        }
        case 'SLEEP': {
          if (!isString(node.query) || !/^\d+$/.test(node.query.trim()))
            return fail(`Step ${node.node_id} has an invalid sleep duration`)
          return wrap(node, safeSql`df.sleep(${literal(Number(node.query.trim()))}::bigint)`)
        }
        case 'SIGNAL': {
          const config = requireConfig(node)
          if (!isNonEmptyString(config.signal_name))
            return fail(`Step ${node.node_id} has no signal name`)
          const timeout = config.timeout_seconds
          if (timeout === null || timeout === undefined)
            return wrap(node, safeSql`df.wait_for_signal(${literal(config.signal_name)})`)
          if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0)
            return fail(`Step ${node.node_id} has an invalid signal timeout`)
          return wrap(
            node,
            safeSql`df.wait_for_signal(${literal(config.signal_name)}, ${literal(timeout)}::integer)`
          )
        }
        case 'WAIT_SCHEDULE': {
          const config = requireConfig(node)
          if (!isNonEmptyString(config.cron_expr))
            return fail(`Step ${node.node_id} has no cron expression`)
          return wrap(node, safeSql`df.wait_for_schedule(${literal(config.cron_expr)})`)
        }
        case 'HTTP':
        case 'HTTP_MULTIPART': {
          const config = requireConfig(node)
          if (!isNonEmptyString(config.url) || !isNonEmptyString(config.method))
            return fail(`Step ${node.node_id} has an invalid HTTP configuration`)
          const headers = config.headers
          if (
            headers !== null &&
            headers !== undefined &&
            (typeof headers !== 'object' || Array.isArray(headers))
          )
            return fail(`Step ${node.node_id} has invalid HTTP headers`)
          const headersSql = headers ? jsonb(headers) : safeSql`NULL`
          const rawTimeout = config.timeout_seconds
          if (rawTimeout !== null && rawTimeout !== undefined && typeof rawTimeout !== 'number')
            return fail(`Step ${node.node_id} has an invalid HTTP timeout`)
          const timeout = rawTimeout ?? 30
          if (type === 'HTTP') {
            const body = config.body
            if (body !== null && body !== undefined && !isString(body))
              return fail(`Step ${node.node_id} has an invalid HTTP body`)
            return wrap(
              node,
              safeSql`df.http(${literal(config.url)}, ${literal(config.method)}, ${literal(body ?? null)}, ${headersSql}, ${literal(timeout)})`
            )
          }
          if (config.parts === null || config.parts === undefined)
            return fail(`Step ${node.node_id} has no multipart parts`)
          return wrap(
            node,
            safeSql`df.http_multipart(${literal(config.url)}, ${literal(config.method)}, ${jsonb(config.parts)}, ${headersSql}, ${literal(timeout)})`
          )
        }
        case 'BREAK': {
          const config = getNodeConfig(node)
          const value = config?.break_value
          if (value !== null && value !== undefined && !isString(value))
            return fail(`Step ${node.node_id} has an invalid break value`)
          return wrap(
            node,
            isNonEmptyString(value) ? safeSql`df.break(${literal(value)})` : safeSql`df.break()`
          )
        }
        case 'RACE': {
          const left = emit(requireChild(node, node.left_node, 'left'))
          const right = emit(requireChild(node, node.right_node, 'right'))
          return wrap(node, safeSql`df.race(${left}, ${right})`)
        }
        case 'JOIN': {
          const config = getNodeConfig(node)
          const extra = config?.extra_nodes
          if (extra !== undefined && extra !== null && !Array.isArray(extra))
            return fail(`Step ${node.node_id} has an invalid list of parallel branches`)
          const ids = [
            requireChild(node, node.left_node, 'left'),
            requireChild(node, node.right_node, 'right'),
          ]
          for (const e of extra ?? []) {
            if (!isNonEmptyString(e))
              return fail(`Step ${node.node_id} has an invalid list of parallel branches`)
            ids.push(e)
          }
          const [first, ...rest] = ids.map(emit)
          const folded = rest.reduce((l, r) => safeSql`df.join(${l}, ${r})`, first)
          return wrap(node, folded)
        }
        case 'IF': {
          const config = requireConfig(node)
          const thenSql = emit(requireChild(node, node.left_node, 'then'))
          const elseSql = emit(requireChild(node, node.right_node, 'else'))
          if (config.condition_type === 'result_has_rows') {
            if (!isNonEmptyString(config.result_name))
              return fail(`Step ${node.node_id} does not name the result it checks`)
            return wrap(
              node,
              safeSql`df.if_rows(${literal(config.result_name)}, ${thenSql}, ${elseSql})`
            )
          }
          if (!isNonEmptyString(config.condition_node))
            return fail(`Step ${node.node_id} has no condition`)
          const condition = emit(config.condition_node)
          return wrap(node, safeSql`df.if(${condition}, ${thenSql}, ${elseSql})`)
        }
        case 'LOOP': {
          const config = getNodeConfig(node)
          if (node.query && !config)
            return fail(`Step ${node.node_id} has an invalid configuration`)
          const body = emit(requireChild(node, node.left_node, 'body'))
          const parts: SafeSqlFragment[] = [body]
          if (config?.condition_node !== undefined && config.condition_node !== null) {
            if (!isNonEmptyString(config.condition_node))
              return fail(`Step ${node.node_id} has an invalid condition`)
            parts.push(emit(config.condition_node))
          }
          if (config?.continue_on_failure === true) parts.push(safeSql`continue_on_failure => true`)
          const args = parts.reduce((l, r) => safeSql`${l}, ${r}`)
          return wrap(node, safeSql`df.loop(${args})`)
        }
        default:
          return fail(`Unsupported step type ${node.node_type}`)
      }
    }

    return { expression: emit(resolvedRoot) }
  } catch (error) {
    if (error instanceof ReconstructError) return { error: error.message }
    return { error: 'The workflow could not be reconstructed' }
  }
}
