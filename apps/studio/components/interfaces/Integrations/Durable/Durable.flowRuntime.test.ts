import { describe, expect, it } from 'vitest'

import { getFirstFailedNodeId } from './Durable.flow'
import {
  byId,
  edgePairs,
  durableNode as node,
  runtimeGraph as runtime,
} from './Durable.flow.fixtures'
import { getRuntimeSummary } from './Durable.flowRuntime'

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
