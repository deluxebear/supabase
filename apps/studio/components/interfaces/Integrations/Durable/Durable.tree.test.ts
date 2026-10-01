import { describe, expect, it } from 'vitest'

import { buildNodeTree, findRootId, getNodeConfig, parseExecutionGeneration } from './Durable.tree'
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

describe('buildNodeTree', () => {
  it('returns null for empty input', () => {
    expect(buildNodeTree(null, [])).toBeNull()
  })

  it('flattens a THEN chain of 4 SQL nodes into ordered steps', () => {
    const nodes = [
      node({ node_id: 't1', node_type: 'THEN', left_node: 's1', right_node: 't2' }),
      node({ node_id: 't2', node_type: 'THEN', left_node: 't3', right_node: 's4' }),
      node({ node_id: 't3', node_type: 'THEN', left_node: 's2', right_node: 's3' }),
      node({ node_id: 's1' }),
      node({ node_id: 's2' }),
      node({ node_id: 's3' }),
      node({ node_id: 's4' }),
    ]
    const tree = buildNodeTree('t1', nodes)!
    expect(tree.role).toBe('root')
    expect(tree.children.map((c) => [c.id, c.role])).toEqual([
      ['s1', 'step'],
      ['s2', 'step'],
      ['s3', 'step'],
      ['s4', 'step'],
    ])
  })

  it('builds IF with condition, then, else', () => {
    const nodes = [
      node({
        node_id: 'if',
        node_type: 'IF',
        query: JSON.stringify({ condition_node: 'c' }),
        left_node: 'a',
        right_node: 'b',
      }),
      node({ node_id: 'c' }),
      node({ node_id: 'a' }),
      node({ node_id: 'b' }),
    ]
    const tree = buildNodeTree('if', nodes)!
    expect(tree.children.map((c) => [c.id, c.role])).toEqual([
      ['c', 'condition'],
      ['a', 'then'],
      ['b', 'else'],
    ])
  })

  it('has no condition child for if_rows config', () => {
    const nodes = [
      node({
        node_id: 'if',
        node_type: 'IF',
        query: JSON.stringify({ condition_type: 'result_has_rows', result_name: 'r' }),
        left_node: 'a',
        right_node: 'b',
      }),
      node({ node_id: 'a' }),
      node({ node_id: 'b' }),
    ]
    const tree = buildNodeTree('if', nodes)!
    expect(tree.children.map((c) => c.role)).toEqual(['then', 'else'])
  })

  it('builds LOOP body + condition with inLoop propagated', () => {
    const nodes = [
      node({
        node_id: 'loop',
        node_type: 'LOOP',
        query: JSON.stringify({ condition_node: 'c' }),
        left_node: 'body',
      }),
      node({ node_id: 'body', node_type: 'THEN', left_node: 'x', right_node: 'y' }),
      node({ node_id: 'x' }),
      node({ node_id: 'y' }),
      node({ node_id: 'c' }),
    ]
    const tree = buildNodeTree('loop', nodes)!
    expect(tree.inLoop).toBe(false)
    expect(tree.children.map((c) => [c.id, c.role, c.inLoop])).toEqual([
      ['body', 'body', true],
      ['c', 'condition', true],
    ])
    expect(tree.children[0].children.map((c) => c.inLoop)).toEqual([true, true])
  })

  it('propagates inLoop only below a LOOP nested in a THEN', () => {
    const nodes = [
      node({ node_id: 't', node_type: 'THEN', left_node: 'before', right_node: 'loop' }),
      node({ node_id: 'before' }),
      node({
        node_id: 'loop',
        node_type: 'LOOP',
        query: JSON.stringify({ condition_node: 'c' }),
        left_node: 'body',
      }),
      node({ node_id: 'body' }),
      node({ node_id: 'c' }),
    ]
    const tree = buildNodeTree('t', nodes)!
    const [before, loop] = tree.children
    expect(before.inLoop).toBe(false)
    expect(loop.inLoop).toBe(false)
    expect(loop.children.every((c) => c.inLoop)).toBe(true)
  })

  it('builds JOIN with one extra as 3 numbered branches', () => {
    const nodes = [
      node({
        node_id: 'j',
        node_type: 'JOIN',
        query: JSON.stringify({ extra_nodes: ['c'] }),
        left_node: 'a',
        right_node: 'b',
      }),
      node({ node_id: 'a' }),
      node({ node_id: 'b' }),
      node({ node_id: 'c' }),
    ]
    const tree = buildNodeTree('j', nodes)!
    expect(tree.children.map((c) => [c.id, c.role, c.branchIndex])).toEqual([
      ['a', 'branch', 1],
      ['b', 'branch', 2],
      ['c', 'branch', 3],
    ])
  })

  it('falls back to the unreferenced node when rootId is null', () => {
    const nodes = [
      node({ node_id: 'a' }),
      node({ node_id: 'root', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'b' }),
    ]
    expect(findRootId(null, nodes)).toBe('root')
    expect(findRootId('missing', nodes)).toBe('root')
    expect(buildNodeTree(null, nodes)!.id).toBe('root')
  })

  it('terminates on cycles with a null leaf', () => {
    const nodes = [
      node({ node_id: 'a', node_type: 'RACE', left_node: 'b' }),
      node({ node_id: 'b', node_type: 'RACE', left_node: 'a' }),
    ]
    const tree = buildNodeTree('a', nodes)!
    expect(tree.children[0].id).toBe('b')
    expect(tree.children[0].children[0].node).toBeNull()
  })

  it('yields a null child for a dangling right_node', () => {
    const nodes = [
      node({ node_id: 'if', node_type: 'IF', left_node: 'a', right_node: 'gone' }),
      node({ node_id: 'a' }),
    ]
    const tree = buildNodeTree('if', nodes)!
    expect(tree.children[1]).toMatchObject({ id: 'gone', role: 'else', node: null })
  })
})

describe('long THEN chains', () => {
  const N = 5000
  const steps = Array.from({ length: N }, (_, i) => node({ node_id: `s${i}` }))
  const expected = steps.map((s) => s.node_id)

  it('flattens a right-nested chain without overflowing', () => {
    const thens = Array.from({ length: N - 1 }, (_, i) =>
      node({
        node_id: `t${i}`,
        node_type: 'THEN',
        left_node: `s${i}`,
        right_node: i === N - 2 ? `s${N - 1}` : `t${i + 1}`,
      })
    )
    const tree = buildNodeTree('t0', [...thens, ...steps])!
    expect(tree.children.map((c) => c.id)).toEqual(expected)
    expect(tree.children.every((c) => c.role === 'step')).toBe(true)
  })

  it('flattens a left-nested chain without overflowing', () => {
    const thens = Array.from({ length: N - 1 }, (_, i) =>
      node({
        node_id: `t${i}`,
        node_type: 'THEN',
        left_node: i === N - 2 ? `s0` : `t${i + 1}`,
        right_node: `s${N - 1 - i}`,
      })
    )
    const tree = buildNodeTree('t0', [...thens, ...steps])!
    expect(tree.children.map((c) => c.id)).toEqual(expected)
  })
})

describe('parseExecutionGeneration', () => {
  it('reads the last :: token', () => {
    expect(parseExecutionGeneration('{"execution_id":"a1b2c3d4::1::7f9a0012::2"}')).toBe(2)
  })
  it('returns null on malformed input', () => {
    expect(parseExecutionGeneration('{nope')).toBeNull()
    expect(parseExecutionGeneration(null)).toBeNull()
    expect(parseExecutionGeneration('{"execution_id":"a::b"}')).toBeNull()
    expect(parseExecutionGeneration('{}')).toBeNull()
  })
})

describe('getNodeConfig', () => {
  it('parses object queries only', () => {
    expect(getNodeConfig(node({ node_id: 'a', query: '{"x":1}' }))).toEqual({ x: 1 })
    expect(getNodeConfig(node({ node_id: 'a', query: 'SELECT 1' }))).toBeNull()
    expect(getNodeConfig(node({ node_id: 'a', query: '[1]' }))).toBeNull()
  })
})
