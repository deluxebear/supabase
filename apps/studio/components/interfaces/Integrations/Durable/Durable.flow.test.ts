import { describe, expect, it } from 'vitest'

import {
  formToFlowGraph,
  getEdgeAppearance,
  getFirstFailedNodeId,
  getRuntimeSummary,
  treeToFlowGraph,
  type FlowGraph,
} from './Durable.flow'
import { buildNodeTree } from './Durable.tree'
import {
  createDefaultContainer,
  createDefaultLeafStep,
  createDefaultStep,
  workflowDefaultValues,
  type LeafStep,
  type WorkflowStep,
} from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

const node = (overrides: Partial<DurableNode> & { node_id: string }): DurableNode => ({
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

const runtime = (rootId: string, nodes: DurableNode[]) => {
  const tree = buildNodeTree(rootId, nodes)
  if (!tree) throw new Error('empty tree')
  return treeToFlowGraph(tree)
}

const byId = (graph: FlowGraph, id: string) => {
  const found = graph.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

const edgePairs = (graph: FlowGraph) =>
  graph.edges.map((e) => `${e.source}->${e.target}${e.label ? `:${e.label}` : ''}`)

const leaf = (overrides: Partial<LeafStep>): LeafStep => ({
  ...createDefaultLeafStep(),
  ...overrides,
})

const values = (steps: WorkflowStep[], composition: 'sequential' | 'parallel' = 'sequential') => ({
  ...workflowDefaultValues,
  composition,
  steps,
})

describe('getRuntimeSummary', () => {
  it.each([
    [
      { node_type: 'SIGNAL', query: '{"signal_name":"approve","timeout_seconds":60}' },
      'approve · 60s',
    ],
    [{ node_type: 'SIGNAL', query: '{"signal_name":"approve"}' }, 'approve'],
    [{ node_type: 'HTTP', query: '{"url":"https://x.dev","method":"POST"}' }, 'POST https://x.dev'],
    [{ node_type: 'WAIT_SCHEDULE', query: '{"cron_expr":"0 * * * *"}' }, '0 * * * *'],
    [{ node_type: 'BREAK', query: '{"break_value":{"ok":true}}' }, '{"ok":true}'],
    [{ node_type: 'SLEEP', query: ' 30 ' }, '30s'],
    [{ node_type: 'SQL', query: '\n  \nSELECT 1\nFROM t' }, 'SELECT 1'],
    [{ node_type: 'SQL', query: null }, undefined],
  ])('summarizes runtime node %#', (overrides, expected) => {
    expect(getRuntimeSummary(node({ node_id: 'n', ...overrides }))).toBe(expected)
  })
})

describe('treeToFlowGraph', () => {
  it('chains a THEN sequence between start and end', () => {
    const graph = runtime('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'a', query: 'SELECT 1\nFROM x', status: 'completed' }),
      node({ node_id: 'b', node_type: 'SLEEP', query: '30', status: 'running' }),
    ])
    expect(graph.mode).toBe('runtime')
    expect(new Set(edgePairs(graph))).toEqual(new Set(['__start->a', 'a->b', 'b->__end']))
    expect(byId(graph, 'a')).toMatchObject({
      kind: 'step',
      stepType: 'SQL',
      title: 'a',
      summary: 'SELECT 1',
      status: 'completed',
      durableNodeId: 'a',
    })
    expect(byId(graph, 'b')).toMatchObject({ stepType: 'SLEEP', summary: '30s', status: 'running' })
  })

  it('prefers inferred status and result names', () => {
    const graph = runtime('a', [
      node({ node_id: 'a', result_name: 'load', status: 'pending', inferred_status: 'skipped' }),
    ])
    expect(byId(graph, 'a')).toMatchObject({ title: 'load', status: 'skipped' })
  })

  it('draws JOIN branches, including extra nodes, between a fork and an all-merge', () => {
    const graph = runtime('j', [
      node({
        node_id: 'j',
        node_type: 'JOIN',
        left_node: 'a',
        right_node: 'b',
        query: '{"extra_nodes":["c"]}',
        status: 'completed',
      }),
      node({ node_id: 'a' }),
      node({ node_id: 'b' }),
      node({ node_id: 'c' }),
    ])
    expect(byId(graph, 'j:merge')).toMatchObject({
      kind: 'merge',
      mergeMode: 'all',
      durableNodeId: 'j',
      status: 'completed',
    })
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->j:fork',
        'j:fork->a',
        'j:fork->b',
        'j:fork->c',
        'a->j:merge',
        'b->j:merge',
        'c->j:merge',
        'j:merge->__end',
      ])
    )
  })

  it('marks RACE merges as first-to-finish and keeps losing branch status', () => {
    const graph = runtime('r', [
      node({ node_id: 'r', node_type: 'RACE', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'a', status: 'completed' }),
      node({ node_id: 'b', status: 'cancelled' }),
    ])
    expect(byId(graph, 'r:merge').mergeMode).toBe('first')
    expect(byId(graph, 'b').status).toBe('cancelled')
  })

  it('turns IF into a decision with then and else arms', () => {
    const graph = runtime('i', [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 't',
        right_node: 'e',
        query: '{"condition_node":"c"}',
        status: 'completed',
      }),
      node({ node_id: 'c', query: 'SELECT count(*) > 0 FROM jobs' }),
      node({ node_id: 't' }),
      node({ node_id: 'e', status: 'skipped' }),
    ])
    expect(byId(graph, 'i')).toMatchObject({
      kind: 'decision',
      stepType: 'IF',
      summary: 'SELECT count(*) > 0 FROM jobs',
      durableNodeId: 'i',
    })
    expect(graph.nodes.some((n) => n.id === 'c')).toBe(false)
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->i',
        'i->t:then',
        'i->e:else',
        't->i:merge',
        'e->i:merge',
        'i:merge->__end',
      ])
    )
  })

  it('labels IF_ROWS and connects a missing else straight to the merge', () => {
    const graph = runtime('i', [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 't',
        query: '{"condition_type":"result_has_rows","result_name":"rows"}',
      }),
      node({ node_id: 't' }),
    ])
    expect(byId(graph, 'i')).toMatchObject({ stepType: 'IF_ROWS', summary: 'rows' })
    expect(edgePairs(graph)).toContain('i->i:merge:else')
  })

  it('groups a loop body and reports the latest iteration', () => {
    const graph = runtime('l', [
      node({
        node_id: 'l',
        node_type: 'LOOP',
        left_node: 't',
        query: '{"condition_node":"c","continue_on_failure":true}',
        status: 'running',
      }),
      node({ node_id: 'c', query: 'SELECT done FROM state' }),
      node({ node_id: 't', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'a', status_details: '{"execution_id":"x::3"}' }),
      node({ node_id: 'b', status_details: '{"execution_id":"x::2"}' }),
    ])
    expect(byId(graph, 'l')).toMatchObject({
      kind: 'loop',
      stepType: 'LOOP',
      summary: 'SELECT done FROM state',
      continueOnFailure: true,
      iteration: 3,
    })
    expect(byId(graph, 'a')).toMatchObject({ parentId: 'l', iteration: 3 })
    expect(byId(graph, 'b').parentId).toBe('l')
    expect(new Set(edgePairs(graph))).toEqual(new Set(['__start->l', 'a->b', 'l->__end']))
  })

  it('nests runtime loops deeper than the builder allows', () => {
    const graph = runtime('outer', [
      node({ node_id: 'outer', node_type: 'LOOP', left_node: 'inner' }),
      node({ node_id: 'inner', node_type: 'LOOP', left_node: 'x' }),
      node({ node_id: 'x' }),
    ])
    expect(byId(graph, 'inner').parentId).toBe('outer')
    expect(byId(graph, 'x').parentId).toBe('inner')
  })

  it('renders missing references as unknown nodes', () => {
    const graph = runtime('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: 'a', right_node: 'ghost' }),
      node({ node_id: 'a' }),
    ])
    expect(byId(graph, 'ghost')).toMatchObject({ kind: 'unknown', title: 'ghost' })
    expect(edgePairs(graph)).toContain('a->ghost')
  })

  it('keeps ids unique when a node id collides with a synthetic id', () => {
    const graph = runtime('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: '__start', right_node: '__end' }),
      node({ node_id: '__start' }),
      node({ node_id: '__end' }),
    ])
    const ids = graph.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(graph.nodes.filter((n) => n.durableNodeId === '__start')).toHaveLength(1)
    expect(graph.nodes.filter((n) => n.kind === 'start')).toHaveLength(1)
    expect(graph.nodes.filter((n) => n.kind === 'end')).toHaveLength(1)
  })
})

describe('formToFlowGraph', () => {
  it('chains top-level steps with result names or numbered titles', () => {
    const graph = formToFlowGraph(
      values([
        createDefaultStep(),
        { ...createDefaultStep(), type: 'sleep', seconds: '5', resultName: 'nap' },
      ])
    )
    expect(graph.mode).toBe('builder')
    expect(byId(graph, 'step-0')).toMatchObject({
      kind: 'step',
      stepType: 'SQL',
      title: 'Step 1',
      summary: 'SELECT 1 AS result',
      isIncomplete: false,
    })
    expect(byId(graph, 'step-1')).toMatchObject({ stepType: 'SLEEP', title: 'nap', summary: '5s' })
    expect(new Set(edgePairs(graph))).toEqual(
      new Set(['__start->step-0', 'step-0->step-1', 'step-1->__end'])
    )
  })

  it.each([
    [{ type: 'signal', signal: 'go', noTimeout: false, seconds: '10' }, 'SIGNAL', 'go · 10s'],
    [{ type: 'signal', signal: 'go', noTimeout: true }, 'SIGNAL', 'go'],
    [{ type: 'http', url: 'https://x.dev', method: 'PUT' }, 'HTTP', 'PUT https://x.dev'],
    [
      { type: 'multipart', url: 'https://x.dev', method: 'POST' },
      'HTTP_MULTIPART',
      'POST https://x.dev',
    ],
    [{ type: 'schedule', cron: '*/5 * * * *' }, 'WAIT_SCHEDULE', '*/5 * * * *'],
  ] as const)('summarizes builder leaf %#', (overrides, stepType, summary) => {
    const graph = formToFlowGraph(values([{ ...createDefaultStep(), ...overrides }]))
    expect(byId(graph, 'step-0')).toMatchObject({ stepType, summary, isIncomplete: false })
  })

  it('marks empty required fields as incomplete instead of failing', () => {
    const graph = formToFlowGraph(
      values([
        { ...createDefaultStep(), query: '  ' },
        { ...createDefaultStep(), type: 'http', url: '' },
      ])
    )
    expect(byId(graph, 'step-0')).toMatchObject({ isIncomplete: true })
    expect(byId(graph, 'step-0').summary).toBeUndefined()
    expect(byId(graph, 'step-1')).toMatchObject({ isIncomplete: true })
  })

  it('tolerates partially watched values', () => {
    expect(edgePairs(formToFlowGraph({}))).toEqual(['__start->__end'])
    const graph = formToFlowGraph({ steps: [{ type: 'loop' }, { type: 'if' }, {}] })
    expect(byId(graph, 'step-0').kind).toBe('loop')
    expect(byId(graph, 'step-1')).toMatchObject({ kind: 'decision', isIncomplete: true })
    expect(byId(graph, 'step-2')).toMatchObject({
      kind: 'step',
      stepType: 'SQL',
      isIncomplete: true,
    })
  })

  it('groups loop bodies inside the loop node', () => {
    const loop: WorkflowStep = {
      ...createDefaultContainer('loop'),
      condition: 'SELECT false',
      continueOnFailure: true,
      body: [leaf({}), leaf({ type: 'break' })],
    }
    const graph = formToFlowGraph(values([loop]))
    expect(byId(graph, 'step-0')).toMatchObject({
      kind: 'loop',
      summary: 'SELECT false',
      continueOnFailure: true,
    })
    expect(byId(graph, 'step-0-body-0')).toMatchObject({ parentId: 'step-0', title: 'Step 1.1' })
    expect(byId(graph, 'step-0-body-1')).toMatchObject({
      parentId: 'step-0',
      stepType: 'BREAK',
      isIncomplete: false,
    })
    expect(new Set(edgePairs(graph))).toEqual(
      new Set(['__start->step-0', 'step-0-body-0->step-0-body-1', 'step-0->__end'])
    )
  })

  it('draws if arms, numbering else after then, and joins an empty else to the merge', () => {
    const withElse: WorkflowStep = {
      ...createDefaultContainer('if'),
      condition: 'SELECT true',
      else: [leaf({})],
    }
    const graph = formToFlowGraph(values([withElse]))
    expect(byId(graph, 'step-0')).toMatchObject({
      kind: 'decision',
      stepType: 'IF',
      summary: 'SELECT true',
      isIncomplete: false,
    })
    expect(byId(graph, 'step-0-else-0').title).toBe('Step 1.2')
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->step-0',
        'step-0->step-0-then-0:then',
        'step-0-then-0->step-0:merge',
        'step-0->step-0-else-0:else',
        'step-0-else-0->step-0:merge',
        'step-0:merge->__end',
      ])
    )
    const noElse = formToFlowGraph(
      values([{ ...createDefaultContainer('if_rows'), rowsResultName: '' }])
    )
    expect(byId(noElse, 'step-0')).toMatchObject({ stepType: 'IF_ROWS', isIncomplete: true })
    expect(edgePairs(noElse)).toContain('step-0->step-0:merge:else')
  })

  it('draws race and parallel bodies as branches', () => {
    const graph = formToFlowGraph(
      values([createDefaultContainer('race'), createDefaultContainer('parallel')])
    )
    expect(byId(graph, 'step-0:merge').mergeMode).toBe('first')
    expect(byId(graph, 'step-1:merge').mergeMode).toBe('all')
    expect(edgePairs(graph)).toEqual(
      expect.arrayContaining([
        'step-0:fork->step-0-body-0',
        'step-0:fork->step-0-body-1',
        'step-0:merge->step-1:fork',
      ])
    )
  })

  it('wraps top-level steps in a fork for parallel composition', () => {
    const graph = formToFlowGraph(values([createDefaultStep(), createDefaultStep()], 'parallel'))
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->__root:fork',
        '__root:fork->step-0',
        '__root:fork->step-1',
        'step-0->__root:merge',
        'step-1->__root:merge',
        '__root:merge->__end',
      ])
    )
  })
})

describe('getEdgeAppearance', () => {
  it('never mutes builder edges', () => {
    expect(getEdgeAppearance('builder', undefined)).toEqual({ animated: false, isMuted: false })
  })

  it.each([
    ['completed', false, false],
    ['failed', false, false],
    ['running', true, false],
    ['pending', false, true],
    ['skipped', false, true],
    ['cancelled', false, true],
    [null, false, true],
  ])('styles runtime edges into %s nodes', (status, animated, isMuted) => {
    expect(getEdgeAppearance('runtime', status)).toEqual({ animated, isMuted })
  })
})

describe('failed conditions', () => {
  const ifWithFailedCondition = () =>
    runtime('i', [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 't',
        right_node: 'e',
        query: '{"condition_node":"c"}',
        status: 'running',
      }),
      node({ node_id: 'c', query: 'SELECT * FROM missing_tbl', status: 'failed' }),
      node({ node_id: 't', status: 'skipped' }),
      node({ node_id: 'e', status: 'skipped' }),
    ])

  it('keeps the condition node id and status on IF and LOOP nodes', () => {
    expect(byId(ifWithFailedCondition(), 'i')).toMatchObject({
      conditionNodeId: 'c',
      conditionStatus: 'failed',
    })
    const loop = runtime('l', [
      node({
        node_id: 'l',
        node_type: 'LOOP',
        left_node: 'a',
        query: '{"condition_node":"c"}',
        status: 'running',
      }),
      node({ node_id: 'c', status: 'completed' }),
      node({ node_id: 'a' }),
    ])
    expect(byId(loop, 'l')).toMatchObject({ conditionNodeId: 'c', conditionStatus: 'completed' })
  })

  it('preselects the decision whose condition failed', () => {
    expect(getFirstFailedNodeId(ifWithFailedCondition())).toBe('i')
  })
})

describe('getFirstFailedNodeId', () => {
  it('prefers a failed step over its failed container', () => {
    const graph = runtime('l', [
      node({ node_id: 'l', node_type: 'LOOP', left_node: 'a', status: 'failed' }),
      node({ node_id: 'a', status: 'failed' }),
    ])
    expect(getFirstFailedNodeId(graph)).toBe('a')
  })

  it('falls back to a failed container, then to null', () => {
    const graph = runtime('l', [
      node({ node_id: 'l', node_type: 'LOOP', left_node: 'a', status: 'failed' }),
      node({ node_id: 'a', status: 'completed' }),
    ])
    expect(getFirstFailedNodeId(graph)).toBe('l')
    expect(getFirstFailedNodeId(null)).toBeNull()
  })
})
