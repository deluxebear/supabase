import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { FlowGraph } from './Durable.flow'
import { WorkflowFlowDiagram } from './WorkflowFlowDiagram'
import { customRender } from '@/tests/lib/custom-render'

mockAnimationsApi()

const GRAPH: FlowGraph = {
  mode: 'runtime',
  nodes: [
    { id: '__start', kind: 'start', title: '' },
    {
      id: 'a',
      kind: 'step',
      stepType: 'SQL',
      title: 'load',
      summary: 'SELECT 1',
      status: 'completed',
      durableNodeId: 'a',
    },
    {
      id: 'b',
      kind: 'step',
      stepType: 'HTTP',
      title: 'notify',
      summary: 'POST https://x.dev',
      status: 'running',
      durableNodeId: 'b',
    },
    { id: '__end', kind: 'end', title: '' },
  ],
  edges: [
    { id: 'e1', source: '__start', target: 'a' },
    { id: 'e2', source: 'a', target: 'b' },
    { id: 'e3', source: 'b', target: '__end' },
  ],
}

const SelectableDiagram = ({ onSelectNode }: { onSelectNode: (id: string | null) => void }) => {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <WorkflowFlowDiagram
      graph={GRAPH}
      selectedNodeId={selected}
      onSelectNode={(id) => {
        setSelected(id)
        onSelectNode(id)
      }}
    />
  )
}

describe('WorkflowFlowDiagram', () => {
  it('renders nodes with titles, summaries, and terminals', () => {
    customRender(<WorkflowFlowDiagram graph={GRAPH} />)
    const diagram = screen.getByRole('region', { name: 'Workflow diagram' })
    expect(within(diagram).getByText('load')).toBeInTheDocument()
    expect(within(diagram).getByText('POST https://x.dev')).toBeInTheDocument()
    expect(within(diagram).getByText('Start')).toBeInTheDocument()
    expect(within(diagram).getByText('End')).toBeInTheDocument()
  })

  it('selects steps by click and keeps the newest selection', () => {
    const onSelectNode = vi.fn()
    customRender(<SelectableDiagram onSelectNode={onSelectNode} />)
    fireEvent.click(screen.getByText('load'))
    expect(onSelectNode).toHaveBeenLastCalledWith('a')
    fireEvent.click(screen.getByText('notify'))
    expect(onSelectNode).toHaveBeenLastCalledWith('b')
  })

  it('selects a focused step with Enter', () => {
    const onSelectNode = vi.fn()
    customRender(<SelectableDiagram onSelectNode={onSelectNode} />)
    const step = screen.getByRole('group', { name: 'SQL, load, completed' })
    step.focus()
    fireEvent.keyDown(step, { key: 'Enter' })
    expect(onSelectNode).toHaveBeenLastCalledWith('a')
  })

  it('does not capture wheel scrolling meant for the surrounding sheet', () => {
    const { container } = customRender(<WorkflowFlowDiagram graph={GRAPH} />)
    const pane = container.querySelector('.react-flow__pane')
    if (!pane) throw new Error('pane is missing')
    // dispatchEvent returns false when a listener called preventDefault.
    expect(fireEvent.wheel(pane, { deltaY: 120 })).toBe(true)
  })

  it('only makes selectable steps keyboard focusable', () => {
    const { container, unmount } = customRender(
      <WorkflowFlowDiagram graph={GRAPH} onSelectNode={vi.fn()} />
    )
    const focusable = () =>
      [...container.querySelectorAll('.react-flow__node[tabindex="0"]')].map((el) =>
        el.getAttribute('aria-label')
      )
    expect(focusable()).toEqual(['SQL, load, completed', 'HTTP, notify, running'])
    unmount()
    // Without a selection handler (the builder preview) nothing in the diagram is a tab stop.
    const builder = customRender(<WorkflowFlowDiagram graph={GRAPH} />)
    expect(builder.container.querySelectorAll('.react-flow__node[tabindex="0"]')).toHaveLength(0)
  })

  it('opens a larger diagram from Expand', async () => {
    const user = userEvent.setup()
    customRender(<WorkflowFlowDiagram graph={GRAPH} canExpand />)
    await user.click(screen.getByRole('button', { name: 'Expand' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('load')).toBeInTheDocument()
  })

  it('shows a placeholder for incomplete builder steps', () => {
    customRender(
      <WorkflowFlowDiagram
        graph={{
          mode: 'builder',
          nodes: [{ id: 's', kind: 'step', stepType: 'SQL', title: 'Step 1', isIncomplete: true }],
          edges: [],
        }}
      />
    )
    expect(screen.getByText('Not configured yet')).toBeInTheDocument()
  })

  it('captions race merges and shows loop details', () => {
    customRender(
      <WorkflowFlowDiagram
        graph={{
          mode: 'runtime',
          nodes: [
            { id: 'm', kind: 'merge', title: '', mergeMode: 'first' },
            {
              id: 'l',
              kind: 'loop',
              stepType: 'LOOP',
              title: 'poll',
              summary: 'SELECT done',
              continueOnFailure: true,
              iteration: 4,
            },
          ],
          edges: [],
        }}
      />
    )
    expect(screen.getByText('First to finish')).toBeInTheDocument()
    expect(screen.getByText('SELECT done')).toBeInTheDocument()
    expect(screen.getByText('Continue after step failures')).toBeInTheDocument()
    expect(screen.getByText('Iteration 4')).toBeInTheDocument()
  })
})
