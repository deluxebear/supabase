import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { HttpResponse } from 'msw'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { WorkflowDetailSheet } from './WorkflowDetailSheet'
import type { DurableConfiguration, DurableNode } from '@/data/pg-durable/pg-durable.types'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

mockAnimationsApi()
const PROJECT = { data: { ref: 'default', connectionString: '' } }
vi.mock('@/hooks/misc/useSelectedProject', () => ({ useSelectedProjectQuery: () => PROJECT }))

const INSTANCE_ID = 'inst-1'

const CONFIGURATION: DurableConfiguration = {
  version: '0.2.8',
  role: 'postgres',
  can_start: true,
  can_signal: true,
  can_cancel: true,
  can_metrics: true,
  preloaded: true,
  database: null,
  current_database: null,
  worker_role: null,
  retention_days: null,
  reconcile_interval: null,
  installed_version: '0.2.8',
  default_version: null,
  can_explain: true,
  log_workflow_sql: null,
  host: null,
  max_new_transaction_starts: null,
  new_transaction_start_timeout: null,
  list_instances_max_limit: null,
  enable_superuser_instances: null,
  max_user_connections: null,
  max_management_connections: null,
  max_duroxide_connections: null,
  execution_acquire_timeout: null,
}

const node = (overrides: Partial<DurableNode>): DurableNode => ({
  node_id: 'n',
  node_type: 'SQL',
  query: null,
  result_name: null,
  left_node: null,
  right_node: null,
  status: 'completed',
  result: null,
  status_details: null,
  inferred_status: null,
  inferred_status_from_ancestor_id: null,
  updated_at: null,
  ...overrides,
})

const CHAIN: DurableNode[] = [
  node({ node_id: 't1', node_type: 'THEN', left_node: 'a', right_node: 't2' }),
  node({ node_id: 't2', node_type: 'THEN', left_node: 'b', right_node: 'c' }),
  node({ node_id: 'a', query: 'SELECT 1', result: '"first ok"' }),
  node({
    node_id: 'b',
    query: 'SELECT 2',
    status: 'failed',
    result: '"boom explosion"',
    status_details: '{"note":"metadata-detail-text"}',
  }),
  node({
    node_id: 'c',
    query: 'SELECT 3',
    status: 'skipped',
    inferred_status_from_ancestor_id: 'b',
  }),
]

const mockQueries = (nodes: DurableNode[] = CHAIN) => {
  const requests: string[] = []
  addAPIMock({
    method: 'post',
    path: '/platform/pg-meta/:ref/query',
    response: async ({ request }) => {
      const { query } = z.object({ query: z.string() }).parse(await request.json())
      requests.push(query)
      if (query.includes('df.explain')) return HttpResponse.json([{ plan: 'Plan: seq(sql)' }])
      return HttpResponse.json([
        {
          detail: {
            info: {
              instance_id: INSTANCE_ID,
              label: 'nightly',
              function_name: null,
              function_version: null,
              current_execution_id: 1,
              status: 'failed',
              output: null,
              root_node: 't1',
              created_at: '2026-09-30T10:11:12Z',
              completed_at: null,
              submitted_by: 'alice',
              database: null,
            },
            nodes,
            executions: [],
          },
        },
      ])
    },
  })
  return requests
}

const renderSheet = (props: Partial<ComponentProps<typeof WorkflowDetailSheet>> = {}) => {
  const onRerun = vi.fn()
  customRender(
    <WorkflowDetailSheet
      instanceId={INSTANCE_ID}
      configuration={CONFIGURATION}
      canWrite
      canStart
      onRerun={onRerun}
      onClose={vi.fn()}
      {...props}
    />
  )
  return { onRerun, user: userEvent.setup() }
}

const showList = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('radio', { name: 'List' }))
}

beforeEach(() => {
  toastError.mockClear()
})

describe('workflow detail sheet', () => {
  it('renders steps in chain order in the list view', async () => {
    mockQueries()
    const { user } = renderSheet()
    await showList(user)
    await waitFor(() => expect(screen.getAllByText('SQL')).toHaveLength(3))
    const ids = ['a', 'b', 'c'].map((id) => screen.getByText(id))
    for (let i = 0; i < ids.length - 1; i++) {
      expect(
        ids[i].compareDocumentPosition(ids[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })

  it('shows the graph by default and preselects the failed step', async () => {
    mockQueries()
    renderSheet()
    const diagram = await screen.findByRole('region', { name: 'Workflow diagram' })
    expect(within(diagram).getByRole('group', { name: 'SQL, b, failed' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Graph' })).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText(/boom explosion/)).toBeInTheDocument()
  })

  it('shows the details of a clicked step', async () => {
    mockQueries()
    renderSheet()
    const diagram = await screen.findByRole('region', { name: 'Workflow diagram' })
    fireEvent.click(within(diagram).getByText('a'))
    expect(await screen.findByText(/first ok/)).toBeInTheDocument()
    expect(screen.queryByText(/boom explosion/)).not.toBeInTheDocument()
  })

  it('shows the error of a failed condition for the selected decision', async () => {
    mockQueries([
      node({
        node_id: 't1',
        node_type: 'IF',
        left_node: 't',
        right_node: 'e',
        query: '{"condition_node":"c"}',
        status: 'running',
      }),
      node({
        node_id: 'c',
        query: 'SELECT * FROM missing_tbl',
        status: 'failed',
        result: '"relation missing_tbl does not exist"',
      }),
      node({ node_id: 't', status: 'skipped' }),
      node({ node_id: 'e', status: 'skipped' }),
    ])
    renderSheet()
    expect(await screen.findByText(/relation missing_tbl does not exist/)).toBeInTheDocument()
    expect(screen.getByText('Condition')).toBeInTheDocument()
  })

  it('asks for a selection when nothing failed', async () => {
    mockQueries(CHAIN.map((n) => ({ ...n, status: 'completed' })))
    renderSheet()
    await screen.findByRole('region', { name: 'Workflow diagram' })
    expect(screen.getByText('Select a step to see its details.')).toBeInTheDocument()
  })

  it('shows failed results as errors and keeps metadata neutral', async () => {
    mockQueries()
    renderSheet()
    const error = await screen.findByText(/boom explosion/)
    expect(error.className).toContain('text-destructive')
    const metadata = screen.getByText(/metadata-detail-text/)
    expect(metadata.closest('.text-destructive')).toBeNull()
    expect(metadata.closest('details')).not.toHaveAttribute('open')
  })

  it('explains skipped steps', async () => {
    mockQueries()
    const { user } = renderSheet()
    await showList(user)
    expect(
      await screen.findByText("Skipped because step b decided this branch won't run.")
    ).toBeInTheDocument()
  })

  it('shows header metadata', async () => {
    mockQueries()
    renderSheet()
    await screen.findByText('alice')
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Submitted by')).toBeInTheDocument()
    expect(screen.getByText(/^2026-09-30 /)).toBeInTheDocument()
  })

  it('re-runs with the reconstructed expression', async () => {
    mockQueries()
    const { onRerun, user } = renderSheet()
    await screen.findByText(/boom explosion/)
    await user.click(screen.getByRole('button', { name: 'Re-run' }))
    expect(onRerun).toHaveBeenCalledWith({
      mode: 'expression',
      expression: "df.seq(df.sql('SELECT 1'), df.seq(df.sql('SELECT 2'), df.sql('SELECT 3')))",
      label: 'nightly',
      transactionMode: 'caller',
    })
  })

  it('disables re-run when workflows cannot be started', async () => {
    mockQueries()
    renderSheet({ canStart: false })
    await screen.findByText(/boom explosion/)
    expect(screen.getByRole('button', { name: 'Re-run' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('reports reconstruction errors instead of re-running', async () => {
    mockQueries([node({ node_id: 't1', node_type: 'FOO' })])
    const { onRerun, user } = renderSheet()
    await screen.findByText('FOO')
    await user.click(screen.getByRole('button', { name: 'Re-run' }))
    expect(toastError).toHaveBeenCalledOnce()
    expect(String(toastError.mock.calls[0][0])).toContain("This workflow can't be re-run:")
    expect(onRerun).not.toHaveBeenCalled()
  })

  it('hides the plan when explain is unavailable', async () => {
    mockQueries()
    renderSheet({ configuration: { ...CONFIGURATION, can_explain: false } })
    await screen.findByText('Steps')
    expect(screen.queryByText('Plan')).not.toBeInTheDocument()
  })

  it('loads the plan when the section opens', async () => {
    const requests = mockQueries()
    renderSheet()
    // jsdom does not dispatch `toggle` for details, so open it and fire the event directly.
    const details = (await screen.findByText('Plan')).closest('details')
    if (!details) throw new Error('Plan section is missing')
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(await screen.findByText('Plan: seq(sql)')).toBeInTheDocument()
    expect(requests).toContain(`SELECT df.explain('${INSTANCE_ID}') AS plan;`)
  })
})
