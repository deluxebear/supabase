import dagre from '@dagrejs/dagre'
import { describe, expect, it, vi } from 'vitest'

import type { FlowGraph, FlowNode } from './Durable.flow'
import {
  getFlowStructureKey,
  layoutFlowGraph,
  LOOP_HEADER_HEIGHT,
  LOOP_PADDING,
  type FlowDiagramNode,
} from './Durable.flowLayout'

const flowNode = (id: string, kind: FlowNode['kind'] = 'step', parentId?: string): FlowNode => ({
  id,
  kind,
  title: id,
  ...(parentId === undefined ? {} : { parentId }),
})

const graphOf = (nodes: FlowNode[], pairs: [string, string][]): FlowGraph => ({
  mode: 'runtime',
  nodes,
  edges: pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
})

const get = (nodes: FlowDiagramNode[], id: string) => {
  const found = nodes.find((n) => n.id === id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

describe('layoutFlowGraph', () => {
  it('positions every node and orders a sequence top to bottom', () => {
    const { nodes, edges } = layoutFlowGraph(
      graphOf(
        [flowNode('__start', 'start'), flowNode('a'), flowNode('b'), flowNode('__end', 'end')],
        [
          ['__start', 'a'],
          ['a', 'b'],
          ['b', '__end'],
        ]
      )
    )
    const y = (id: string) => get(nodes, id).position.y
    expect(y('__start')).toBeLessThan(y('a'))
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('__end'))
    expect(get(nodes, 'a')).toMatchObject({
      type: 'step',
      width: 240,
      height: 64,
      draggable: false,
      connectable: false,
    })
    expect(edges.map((e) => e.id)).toEqual(['__start->a', 'a->b', 'b->__end'])
  })

  it('places loop children inside their group, after the group', () => {
    const { nodes } = layoutFlowGraph(
      graphOf(
        [
          flowNode('__start', 'start'),
          flowNode('l', 'loop'),
          flowNode('a', 'step', 'l'),
          flowNode('b', 'step', 'l'),
          flowNode('__end', 'end'),
        ],
        [
          ['__start', 'l'],
          ['a', 'b'],
          ['l', '__end'],
        ]
      )
    )
    const ids = nodes.map((n) => n.id)
    expect(ids.indexOf('l')).toBeLessThan(ids.indexOf('a'))
    const loop = get(nodes, 'l')
    const a = get(nodes, 'a')
    const b = get(nodes, 'b')
    expect(a).toMatchObject({ parentId: 'l', extent: 'parent' })
    for (const child of [a, b]) {
      expect(child.position.x).toBeGreaterThanOrEqual(LOOP_PADDING)
      expect(child.position.y).toBeGreaterThanOrEqual(LOOP_HEADER_HEIGHT + LOOP_PADDING)
      expect(child.position.x + (child.width ?? 0)).toBeLessThanOrEqual(
        (loop.width ?? 0) - LOOP_PADDING
      )
      expect(child.position.y + (child.height ?? 0)).toBeLessThanOrEqual(
        (loop.height ?? 0) - LOOP_PADDING
      )
    }
    expect(a.position.y).toBeLessThan(b.position.y)
  })

  it('sizes an empty loop to the minimum body', () => {
    const { nodes } = layoutFlowGraph(graphOf([flowNode('l', 'loop')], []))
    expect(get(nodes, 'l')).toMatchObject({
      width: 240 + 2 * LOOP_PADDING,
      height: LOOP_HEADER_HEIGHT + 48 + 2 * LOOP_PADDING,
    })
  })

  it('nests loops at any depth', () => {
    const { nodes } = layoutFlowGraph(
      graphOf([flowNode('o', 'loop'), flowNode('i', 'loop', 'o'), flowNode('x', 'step', 'i')], [])
    )
    expect(nodes.map((n) => n.id)).toEqual(['o', 'i', 'x'])
    expect(get(nodes, 'i').parentId).toBe('o')
    expect(get(nodes, 'x').parentId).toBe('i')
    expect(get(nodes, 'o').width ?? 0).toBeGreaterThan(get(nodes, 'i').width ?? 0)
  })

  it('drops edges that reference unknown nodes', () => {
    const { edges } = layoutFlowGraph(
      graphOf(
        [flowNode('a')],
        [
          ['a', 'ghost'],
          ['ghost', 'a'],
        ]
      )
    )
    expect(edges).toEqual([])
  })

  it('marks only nodes with a durable node id as selectable', () => {
    const { nodes } = layoutFlowGraph(
      graphOf([{ ...flowNode('a'), durableNodeId: 'a' }, flowNode('__start', 'start')], [])
    )
    expect(get(nodes, 'a').selectable).toBe(true)
    expect(get(nodes, '__start').selectable).toBe(false)
  })

  it('passes edge labels through as data', () => {
    const graph: FlowGraph = {
      mode: 'builder',
      nodes: [flowNode('d', 'decision'), flowNode('t')],
      edges: [{ id: 'd->t', source: 'd', target: 't', label: 'then' }],
    }
    expect(layoutFlowGraph(graph).edges[0]).toMatchObject({
      type: 'smoothstep',
      data: { label: 'then' },
    })
  })
})

describe('layout caching', () => {
  it('reuses positions while only status and summary change, but refreshes node data', () => {
    const base = graphOf(
      [flowNode('a'), flowNode('l', 'loop'), flowNode('b', 'step', 'l')],
      [['a', 'l']]
    )
    const spy = vi.spyOn(dagre, 'layout')
    try {
      const first = layoutFlowGraph(base)
      const callsAfterFirst = spy.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)

      const polled: FlowGraph = {
        ...base,
        nodes: base.nodes.map((n) => ({ ...n, status: 'failed', summary: 'changed' })),
      }
      const second = layoutFlowGraph(polled)
      expect(spy.mock.calls.length).toBe(callsAfterFirst)
      expect(second.nodes.map((n) => n.position)).toEqual(first.nodes.map((n) => n.position))
      expect(get(second.nodes, 'a').data.flow).toMatchObject({
        status: 'failed',
        summary: 'changed',
      })

      layoutFlowGraph(graphOf([...base.nodes, flowNode('c')], [['a', 'l']]))
      expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getFlowStructureKey', () => {
  it('ignores status and summary changes', () => {
    const base = graphOf([flowNode('a'), flowNode('b')], [['a', 'b']])
    const polled: FlowGraph = {
      ...base,
      nodes: base.nodes.map((n) => ({ ...n, status: 'completed', summary: 'changed' })),
    }
    expect(getFlowStructureKey(polled)).toBe(getFlowStructureKey(base))
  })

  it('changes when nodes, edges, or kinds change', () => {
    const base = graphOf([flowNode('a'), flowNode('b')], [['a', 'b']])
    const grown = graphOf(
      [flowNode('a'), flowNode('b'), flowNode('c')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ]
    )
    const retyped = graphOf([flowNode('a', 'loop'), flowNode('b')], [['a', 'b']])
    expect(getFlowStructureKey(grown)).not.toBe(getFlowStructureKey(base))
    expect(getFlowStructureKey(retyped)).not.toBe(getFlowStructureKey(base))
  })
})
