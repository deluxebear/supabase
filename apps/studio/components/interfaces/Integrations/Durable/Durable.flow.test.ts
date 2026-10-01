import { describe, expect, it } from 'vitest'

import { getEdgeAppearance, getFirstFailedNodeId } from './Durable.flow'
import { durableNode as node, runtimeGraph as runtime } from './Durable.flow.fixtures'

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
