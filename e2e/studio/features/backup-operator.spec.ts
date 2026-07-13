import { expect, type Page, type Route } from '@playwright/test'

import { test } from '../utils/test.js'
import { toUrl } from '../utils/to-url.js'

const policy = {
  enabled: true,
  retentionDays: 7,
  fullSchedule: '0 1 * * *',
  diffSchedule: null,
  incrSchedule: '0 * * * *',
  backupFrom: 'primary',
  designatedStandby: null,
  updatedAt: '2026-07-13T10:00:00Z',
}

const backups = {
  backups: [
    {
      id: 'backup-1',
      type: 'full',
      status: 'completed',
      startedAt: '2026-07-13T09:00:00Z',
      completedAt: '2026-07-13T09:10:00Z',
      recoverableUntil: '2026-07-13T10:00:00Z',
    },
  ],
  recoveryWindow: { earliest: '2026-07-13T09:00:00Z', latest: '2026-07-13T10:00:00Z' },
  confidence: 'drill-verified',
  isStale: false,
  blockers: [],
  drill: null,
}

const plan = {
  id: 'plan-1',
  hash: 'exact-plan-hash',
  expiresAt: '2026-07-13T12:00:00Z',
  recoveryTarget: '2026-07-13T09:30:00Z',
  impact: {
    serviceInterruption: 'Writes will stop during recovery.',
    affectedNodes: ['primary'],
    requiredBytes: 1024,
  },
  blockers: [],
}

async function installOperatorFixture(
  page: Page,
  ref: string,
  handler: (route: Route, path: string) => Promise<void>
) {
  await page.route(`**/api/platform/database/${ref}/backup-operator/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.split('/backup-operator/')[1]
    if (route.request().method() === 'GET' && path === 'policy')
      return route.fulfill({ json: policy })
    if (route.request().method() === 'GET' && path === 'backups')
      return route.fulfill({ json: backups })
    await handler(route, path)
  })
}

async function previewPlan(page: Page) {
  await page.getByLabel('Recovery target').fill('2026-07-13T09:30')
  const planResponse = page.waitForResponse((response) =>
    response.url().includes('/backup-operator/restore-plans')
  )
  await page.getByRole('button', { name: 'Preview restore impact' }).click()
  await planResponse
  await expect(
    page.getByText('exact-plan-hash'),
    'Restore plan hash should be rendered'
  ).toBeVisible()
  await page.getByLabel('Exact restore plan hash').fill('exact-plan-hash')
}

test.describe('Self-hosted Backup Operator', () => {
  test('offers an AAL2 upgrade when destructive confirmation is rejected', async ({
    page,
    ref,
  }) => {
    await installOperatorFixture(page, ref, async (route, path) => {
      if (path === 'restore-plans') return route.fulfill({ json: plan })
      if (path === 'restore-plans/plan-1/confirm') {
        return route.fulfill({
          status: 403,
          json: {
            code: 'AAL2_REQUIRED',
            message: 'A recent AAL2 session is required',
            correlation_id: 'e2e-aal2',
            retryable: false,
            details: {},
          },
        })
      }
      await route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
    })
    await page.goto(toUrl(`/project/${ref}/database/backups/scheduled`))
    await expect(
      page.getByText('Backup policy'),
      'Backup Operator UI should load in Studio'
    ).toBeVisible({ timeout: 30_000 })
    await previewPlan(page)
    await page.getByRole('button', { name: 'Confirm and execute restore' }).click()
    await expect(
      page.getByText('Additional authentication required'),
      'AAL2 rejection should produce an upgrade affordance'
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upgrade to AAL2' })).toBeVisible()
  })

  test('renders manual intervention and performs rollback through the browser', async ({
    page,
    ref,
  }) => {
    let rollbackRequests = 0
    await installOperatorFixture(page, ref, async (route, path) => {
      if (path === 'restore-plans') return route.fulfill({ json: plan })
      if (path === 'restore-plans/plan-1/confirm')
        return route.fulfill({ json: { confirmed: true } })
      if (path === 'restore-plans/plan-1/execute' || path === 'jobs/job-manual') {
        return route.fulfill({
          json: {
            id: 'job-manual',
            type: 'restore',
            state: 'rollback-available',
            progress: 100,
            updatedAt: new Date().toISOString(),
            rollbackUntil: new Date(Date.now() + 60_000).toISOString(),
            manualIntervention: {
              code: 'FENCE_RELEASE_FAILED',
              summary: 'Manual review required',
              safeAction: 'Keep the fence engaged.',
              runbookUrl: '/runbook',
            },
          },
        })
      }
      if (path === 'jobs/job-manual/rollback') {
        rollbackRequests++
        return route.fulfill({
          json: {
            id: 'rollback-1',
            type: 'rollback',
            state: 'running',
            progress: 0,
            updatedAt: new Date().toISOString(),
            rollbackUntil: null,
            manualIntervention: null,
          },
        })
      }
      await route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
    })
    await page.goto(toUrl(`/project/${ref}/database/backups/scheduled`))
    await expect(page.getByText('Backup policy')).toBeVisible({ timeout: 30_000 })
    await previewPlan(page)
    await page.getByRole('button', { name: 'Confirm and execute restore' }).click()
    await expect(
      page.getByText('Manual review required'),
      'Manual intervention details should be rendered'
    ).toBeVisible()
    const rollbackResponse = page.waitForResponse((response) =>
      response.url().includes('/jobs/job-manual/rollback')
    )
    await page.getByRole('button', { name: 'Roll back restore' }).click()
    await rollbackResponse
    expect(rollbackRequests).toBe(1)
  })

  test('renders an orphaned restore as a takeover state without rollback', async ({
    page,
    ref,
  }) => {
    await installOperatorFixture(page, ref, async (route, path) => {
      if (path === 'restore-plans') return route.fulfill({ json: plan })
      if (path === 'restore-plans/plan-1/confirm') {
        return route.fulfill({ json: { confirmed: true } })
      }
      if (path === 'restore-plans/plan-1/execute' || path === 'jobs/job-orphan') {
        return route.fulfill({
          json: {
            id: 'job-orphan',
            type: 'restore',
            state: 'orphaned',
            progress: 40,
            updatedAt: new Date().toISOString(),
            rollbackUntil: null,
            manualIntervention: null,
          },
        })
      }
      await route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
    })

    await page.goto(toUrl(`/project/${ref}/database/backups/scheduled`))
    await expect(page.getByText('Backup policy')).toBeVisible({ timeout: 30_000 })
    await previewPlan(page)
    await page.getByRole('button', { name: 'Confirm and execute restore' }).click()
    await expect(page.getByText('orphaned')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Roll back restore' })).toHaveCount(0)
  })
})
