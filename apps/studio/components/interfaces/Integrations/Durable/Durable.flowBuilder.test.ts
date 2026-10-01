import { describe, expect, it } from 'vitest'

import { byId, edgePairs } from './Durable.flow.fixtures'
import { formToFlowGraph } from './Durable.flowBuilder'
import {
  createDefaultContainer,
  createDefaultLeafStep,
  createDefaultStep,
  workflowDefaultValues,
  type LeafStep,
  type WorkflowStep,
} from './Durable.utils'

const leaf = (overrides: Partial<LeafStep>): LeafStep => ({
  ...createDefaultLeafStep(),
  ...overrides,
})

const values = (steps: WorkflowStep[], composition: 'sequential' | 'parallel' = 'sequential') => ({
  ...workflowDefaultValues,
  composition,
  steps,
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
