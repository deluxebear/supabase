import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { HttpResponse } from 'msw'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CreateWorkflowSheet } from './CreateWorkflowSheet'
import { createDefaultStep } from './Durable.utils'
import type { DurableConfiguration } from '@/data/pg-durable/pg-durable.types'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

mockAnimationsApi()
const PROJECT = { data: { ref: 'default', connectionString: '' } }
vi.mock('@/hooks/misc/useSelectedProject', () => ({ useSelectedProjectQuery: () => PROJECT }))

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

const mockQueries = (value: string) => {
  const requests: string[] = []
  addAPIMock({
    method: 'post',
    path: '/platform/pg-meta/:ref/query',
    response: async ({ request }) => {
      const body = z.object({ query: z.string() }).parse(await request.json())
      requests.push(body.query)
      return HttpResponse.json<Record<string, string>[]>([{ value, plan: 'Plan: seq(sql)' }])
    },
  })
  return requests
}

const renderSheet = (props: Partial<ComponentProps<typeof CreateWorkflowSheet>> = {}) => {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  const { unmount } = customRender(
    <CreateWorkflowSheet
      onCreated={onCreated}
      onClose={onClose}
      configuration={CONFIGURATION}
      {...props}
    />
  )
  return { onCreated, onClose, user: userEvent.setup(), unmount }
}

const chooseStepType = async (
  user: ReturnType<typeof userEvent.setup>,
  option: string,
  index = 0
) => {
  await user.click(screen.getAllByRole('combobox', { name: 'Step type' })[index])
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('workflow creation', () => {
  it('previews without executing and starts only after submission', async () => {
    const requests = mockQueries('new-instance')
    const { onCreated, onClose, user } = renderSheet()
    await user.click(screen.getByText('Preview SQL'))
    expect(requests).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-instance'))
    expect(requests).toEqual(["SELECT df.start(df.sql('SELECT 1 AS result'), NULL) AS value;"])
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps edited steps when the user dismisses the discard confirmation', async () => {
    const onClose = vi.fn()
    customRender(
      <CreateWorkflowSheet onCreated={vi.fn()} onClose={onClose} configuration={CONFIGURATION} />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    expect(screen.getAllByLabelText('SQL statement')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getAllByLabelText('SQL statement')).toHaveLength(2)
  })

  it('starts a loop with a default body', async () => {
    const requests = mockQueries('loop-instance')
    const { onCreated, user } = renderSheet()
    await chooseStepType(user, 'Loop')
    expect(screen.getAllByLabelText('SQL statement')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('loop-instance'))
    expect(requests).toEqual([
      "SELECT df.start(df.loop(df.sql('SELECT 1 AS result')), NULL) AS value;",
    ])
  })

  it('disables continue after failures before pg_durable 0.2.8', async () => {
    const { user } = renderSheet({
      configuration: { ...CONFIGURATION, installed_version: '0.2.7' },
    })
    await chooseStepType(user, 'Loop')
    expect(screen.getByRole('switch', { name: 'Continue after step failures' })).toBeDisabled()
  })

  it('offers continue after failures on 0.2.8', async () => {
    const { user } = renderSheet()
    await chooseStepType(user, 'Loop')
    expect(screen.getByRole('switch', { name: 'Continue after step failures' })).toBeEnabled()
  })

  it('starts a re-run expression and shows the notice', async () => {
    const requests = mockQueries('rerun')
    const { onCreated } = renderSheet({
      initialValues: { mode: 'expression', expression: 'df.sleep(1)', label: 'x' },
      notice: 'Re-running a previous workflow',
    })
    expect(screen.getByText('Re-running a previous workflow')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('rerun'))
    expect(requests).toEqual(["SELECT df.start(df.sleep(1), 'x') AS value;"])
  })

  it('rejects a multipart step when the version does not support it', async () => {
    const requests = mockQueries('never')
    const { onCreated } = renderSheet({
      configuration: { ...CONFIGURATION, installed_version: '0.2.4' },
      initialValues: {
        steps: [
          {
            ...createDefaultStep(),
            type: 'multipart',
            url: 'https://example.com',
            parts: '[{"name":"a","data_b64":"AA=="}]',
          },
        ],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    expect(await screen.findByText('Requires pg_durable 0.2.5 or later')).toBeInTheDocument()
    expect(requests).toEqual([])
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('previews the plan without starting the workflow', async () => {
    const requests = mockQueries('unused')
    const { user } = renderSheet()
    await user.click(screen.getByRole('button', { name: 'Preview plan' }))
    expect(await screen.findByText('Plan: seq(sql)')).toBeInTheDocument()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('df.explain(')
    expect(requests.some((query) => query.includes('df.start('))).toBe(false)
  })

  it('generates SQL for steps nested in a loop body', async () => {
    const requests = mockQueries('nested')
    const { onCreated, user } = renderSheet()
    await chooseStepType(user, 'Loop')
    // The loop body's "Add step" renders before the top-level one.
    await user.click(screen.getAllByRole('button', { name: 'Add step' })[0])
    const statements = screen.getAllByLabelText('SQL statement')
    expect(statements).toHaveLength(2)
    fireEvent.change(statements[1], { target: { value: 'SELECT 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('nested'))
    expect(requests).toEqual([
      "SELECT df.start(df.loop(df.seq(df.sql('SELECT 1 AS result'), df.sql('SELECT 2'))), NULL) AS value;",
    ])
  })

  it('offers break only inside loop bodies', async () => {
    const { user } = renderSheet()
    await user.click(screen.getByRole('combobox', { name: 'Step type' }))
    expect(screen.queryByRole('option', { name: 'Break out of loop' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await chooseStepType(user, 'Loop')
    const comboboxes = screen.getAllByRole('combobox', { name: 'Step type' })
    await user.click(comboboxes[1])
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: 'Break out of loop' })).toBeInTheDocument()
  })

  it('shows start transaction only when supported and starts an independent transaction', async () => {
    const old = renderSheet({ configuration: { ...CONFIGURATION, installed_version: '0.2.4' } })
    expect(screen.queryByText('Start transaction')).not.toBeInTheDocument()
    old.unmount()
    const requests = mockQueries('tx')
    const { onCreated, user } = renderSheet()
    await user.click(screen.getByRole('combobox', { name: 'Start transaction' }))
    await user.click(await screen.findByRole('option', { name: 'Independent transaction' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tx'))
    expect(requests).toEqual([
      "SELECT df.start(df.sql('SELECT 1 AS result'), NULL, NULL, transaction_mode => 'new') AS value;",
    ])
  })

  it('previews an expression as a quoted literal without starting', async () => {
    const requests = mockQueries('unused')
    const { user } = renderSheet({
      initialValues: { mode: 'expression', expression: 'df.sleep(1)' },
    })
    await user.click(screen.getByRole('button', { name: 'Preview plan' }))
    expect(await screen.findByText('Plan: seq(sql)')).toBeInTheDocument()
    expect(requests).toEqual(["SELECT df.explain('df.sleep(1)') AS plan;"])
  })

  it('doubles single quotes in an expression plan request', async () => {
    const requests = mockQueries('unused')
    const { user } = renderSheet({
      initialValues: { mode: 'expression', expression: "df.sql('SELECT 1')" },
    })
    await user.click(screen.getByRole('button', { name: 'Preview plan' }))
    await screen.findByText('Plan: seq(sql)')
    expect(requests).toEqual(["SELECT df.explain('df.sql(''SELECT 1'')') AS plan;"])
  })

  it('clears a displayed plan when the steps change', async () => {
    mockQueries('unused')
    const { user } = renderSheet()
    await user.click(screen.getByRole('button', { name: 'Preview plan' }))
    expect(await screen.findByText('Plan: seq(sql)')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('SQL statement'), { target: { value: 'SELECT 9' } })
    await waitFor(() => expect(screen.queryByText('Plan: seq(sql)')).not.toBeInTheDocument())
  })

  it('shows a live flow preview in builder mode', async () => {
    const { user } = renderSheet()
    const diagram = screen.getByRole('region', { name: 'Workflow diagram' })
    expect(within(diagram).getByText('SELECT 1 AS result')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    const updated = screen.getByRole('region', { name: 'Workflow diagram' })
    expect(within(updated).getAllByText('SELECT 1 AS result')).toHaveLength(2)
  })

  it('shows loop bodies inside the flow preview', async () => {
    const { user } = renderSheet()
    await chooseStepType(user, 'Loop')
    const diagram = screen.getByRole('region', { name: 'Workflow diagram' })
    expect(within(diagram).getByText('LOOP')).toBeInTheDocument()
    expect(within(diagram).getByText('Step 1.1')).toBeInTheDocument()
  })

  it('does not start the workflow when expanding the flow preview', async () => {
    const requests = mockQueries('never')
    const { user, onCreated } = renderSheet()
    // The preview sits inside the form, so Expand must never be a submit button.
    expect(screen.getByRole('button', { name: 'Expand' })).toHaveAttribute('type', 'button')
    await user.click(screen.getByRole('button', { name: 'Expand' }))
    expect(await screen.findByRole('dialog', { name: 'Workflow diagram' })).toBeInTheDocument()
    expect(requests).toEqual([])
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('explains that expression mode has no flow preview', () => {
    renderSheet({ initialValues: { mode: 'expression', expression: 'df.sleep(1)' } })
    expect(screen.queryByRole('region', { name: 'Workflow diagram' })).not.toBeInTheDocument()
    expect(screen.getByText('Flow preview is available in builder mode.')).toBeInTheDocument()
  })

  it('hides Preview plan when explain is unavailable', () => {
    renderSheet({ configuration: { ...CONFIGURATION, can_explain: false } })
    expect(screen.queryByRole('button', { name: 'Preview plan' })).not.toBeInTheDocument()
  })

  it('explains why continue after failures is disabled', async () => {
    const { user } = renderSheet({
      configuration: { ...CONFIGURATION, installed_version: '0.2.7' },
    })
    await chooseStepType(user, 'Loop')
    const toggle = screen.getByRole('switch', { name: 'Continue after step failures' })
    expect(toggle).toBeDisabled()
    await user.hover(toggle.parentElement as HTMLElement)
    expect(
      (await screen.findAllByText('Requires pg_durable 0.2.8 or later')).length
    ).toBeGreaterThan(0)
  })
})
