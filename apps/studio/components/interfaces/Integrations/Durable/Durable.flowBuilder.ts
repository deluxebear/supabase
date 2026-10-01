import type { DeepPartialSkipArrayKey } from 'react-hook-form'

import {
  createGraphBuilder,
  END_ID,
  firstLine,
  single,
  START_ID,
  type FlowGraph,
  type Segment,
} from './Durable.flow'
import type { WorkflowFormValues } from './Durable.utils'
import { t as $t } from '@/lib/i18n'

export type WatchedWorkflowValues = DeepPartialSkipArrayKey<WorkflowFormValues>
type WatchedStep = NonNullable<WatchedWorkflowValues['steps']>[number]
type WatchedLeaf = NonNullable<WatchedStep['body']>[number]

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
