import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { RuntimeConfigurationContent } from './RuntimeConfigurationTab'
import type { DurableConfiguration } from '@/data/pg-durable/pg-durable.types'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

mockAnimationsApi()
const PROJECT = { data: { ref: 'default', connectionString: '' } }
vi.mock('@/hooks/misc/useSelectedProject', () => ({ useSelectedProjectQuery: () => PROJECT }))

const FULL: DurableConfiguration = {
  version: '0.2.8',
  role: 'postgres',
  can_start: true,
  can_signal: true,
  can_cancel: true,
  can_metrics: true,
  preloaded: true,
  database: 'workerdb',
  current_database: 'postgres',
  worker_role: 'workerrole',
  retention_days: '30',
  reconcile_interval: '45',
  installed_version: '0.2.8',
  default_version: '0.2.8',
  can_explain: true,
  log_workflow_sql: 'off',
  host: 'db.example.test',
  max_new_transaction_starts: '11',
  new_transaction_start_timeout: '12',
  list_instances_max_limit: '13',
  enable_superuser_instances: 'off',
  max_user_connections: '14',
  max_management_connections: '15',
  max_duroxide_connections: '16',
  execution_acquire_timeout: '17s',
}

const renderWith = async (overrides: Partial<DurableConfiguration> = {}) => {
  addAPIMock({
    method: 'post',
    path: '/platform/pg-meta/:ref/query',
    response: () => HttpResponse.json([{ ...FULL, ...overrides }]),
  })
  customRender(<RuntimeConfigurationContent />)
  await screen.findByText('Worker')
}

const UPDATE_TITLE = 'An extension update is available'
const FEATURES_TITLE = 'Some workflow features are unavailable'
const LOG_TITLE = 'Workflow SQL is written to Postgres logs'

describe('RuntimeConfigurationTab', () => {
  it('renders the four groups with their values', async () => {
    await renderWith()
    for (const heading of ['Worker', 'Starts and listing', 'Connections', 'Retention and logging'])
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
    for (const value of ['workerdb', 'workerrole', 'db.example.test', '45', '11', '12', '13'])
      expect(screen.getByText(value)).toBeInTheDocument()
    for (const value of ['14', '15', '16', '17s', '30'])
      expect(screen.getByText(value)).toBeInTheDocument()
  })

  it('shows a dash with a tooltip for unavailable values', async () => {
    await renderWith({ host: null })
    const dash = screen.getByText('—')
    await userEvent.hover(dash)
    expect((await screen.findAllByText('Not available in this version')).length).toBeGreaterThan(0)
  })

  it('warns only when log_workflow_sql is on', async () => {
    await renderWith({ log_workflow_sql: 'on' })
    expect(screen.getByText(LOG_TITLE)).toBeInTheDocument()
  })

  it.each(['off', null])('does not warn when log_workflow_sql is %s', async (value) => {
    await renderWith({ log_workflow_sql: value })
    expect(screen.queryByText(LOG_TITLE)).not.toBeInTheDocument()
  })

  it('shows the update admonition when installed is older than default', async () => {
    await renderWith({ installed_version: '0.2.7', default_version: '0.2.8' })
    expect(screen.getByText(UPDATE_TITLE)).toBeInTheDocument()
    // CodeBlock splits the statement into highlighted tokens
    expect(document.body.textContent).toContain('ALTER EXTENSION pg_durable UPDATE;')
    expect(
      screen.getByText(/Let running loops and waits finish before updating/)
    ).toBeInTheDocument()
  })

  it.each([
    ['equal versions', '0.2.8', '0.2.8'],
    ['unparseable versions', 'weird', 'other'],
    ['missing default', '0.2.7', null],
  ])('shows no update admonition for %s', async (_name, installed, available) => {
    await renderWith({ installed_version: installed, default_version: available })
    expect(screen.queryByText(UPDATE_TITLE)).not.toBeInTheDocument()
  })

  it('lists all unavailable features on 0.2.4', async () => {
    await renderWith({ installed_version: '0.2.4' })
    expect(screen.getByText(FEATURES_TITLE)).toBeInTheDocument()
    expect(screen.getByText(/Multipart HTTP requests/)).toBeInTheDocument()
    expect(screen.getByText(/Independent-transaction starts/)).toBeInTheDocument()
    expect(screen.getByText(/Continue after step failures in loops/)).toBeInTheDocument()
  })

  it('lists only the loop feature on 0.2.5', async () => {
    await renderWith({ installed_version: '0.2.5' })
    expect(screen.queryByText(/Multipart HTTP requests/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Independent-transaction starts/)).not.toBeInTheDocument()
    expect(screen.getByText(/Continue after step failures in loops/)).toBeInTheDocument()
  })

  it.each(['0.2.8', null])('shows no feature notice for installed %s', async (installed) => {
    await renderWith({ installed_version: installed })
    expect(screen.queryByText(FEATURES_TITLE)).not.toBeInTheDocument()
  })
})
