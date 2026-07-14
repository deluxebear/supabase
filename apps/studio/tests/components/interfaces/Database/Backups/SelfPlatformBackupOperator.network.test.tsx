import { useQuery } from '@tanstack/react-query'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelfPlatformBackupOperator } from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator'
import {
  backupPolicyQueryOptions,
  operatorBackupsQueryOptions,
  operatorJobQueryOptions,
  restorePlanQueryOptions,
} from '@/data/backup-operator/backup-operator-query'
import { customRender, customRenderHook } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  getAccessToken: vi.fn().mockResolvedValue('platform-access-token'),
}))
vi.mock('@/components/ui/AlertError', () => ({
  AlertError: ({ subject }: { subject: string }) => <div>{subject}</div>,
}))
vi.mock('@/data/profile/mfa-list-factors-query', () => ({
  useMfaListFactorsQuery: () => ({ data: { totp: [] }, isPending: false }),
}))

const policy = {
  enabled: true,
  repositoryId: 'repo-a',
  retentionDays: 7,
  fullSchedule: '0 1 * * *',
  diffSchedule: null,
  incrSchedule: '0 * * * *',
  backupFrom: 'primary',
  designatedStandby: null,
  maxStandbyLagBytes: 0,
  nextRunAt: '2026-07-14T01:00:00Z',
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
  blockers: [] as string[],
  drill: {
    id: 'drill-1',
    targetTime: '2026-07-13T09:30:00Z',
    completedAt: '2026-07-13T10:05:00Z',
    passed: true,
    evidenceDigest: 'sha256:drill-evidence',
  },
}

const restorePlan = {
  id: 'plan-1',
  hash: 'exact-plan-hash',
  expiresAt: '2099-07-13T12:00:00Z',
  recoveryTarget: '2026-07-13T09:30:00Z',
  impact: {
    serviceInterruption: 'Writes will stop during recovery.',
    affectedNodes: ['primary'],
    requiredBytes: 1024,
  },
  blockers: [] as string[],
}

function operatorURL(path: string) {
  return `*/api/platform/database/project-a/backup-operator/${path}`
}

function mockPolicyAndBackups({
  policyResponse = policy,
  backupsResponse = backups,
}: {
  policyResponse?: typeof policy
  backupsResponse?: typeof backups
} = {}) {
  mswServer.use(
    http.get(operatorURL('policy'), () => HttpResponse.json(policyResponse)),
    http.get(operatorURL('backups'), () => HttpResponse.json(backupsResponse)),
    http.get(operatorURL('cluster'), () =>
      HttpResponse.json({
        projectId: 'project-a',
        targetId: 'project-a',
        systemIdentifier: 'postgres-a',
        dataDomain: 'pgdata-a',
        createdAt: '2026-07-13T08:00:00Z',
        discovery: {
          provider: 'single-primary-pgbackrest',
          providerVersion: '2.56',
          topology: 'static-primary',
          primary: 'primary-a',
          standbys: null,
          repositoryId: 'repo-a',
          repositoryType: 's3',
          repositoryLocation: 's3://backups',
          blockers: null,
          observedAt: '2026-07-13T08:00:00Z',
        },
      })
    ),
    http.get(operatorURL('pitr'), () =>
      HttpResponse.json({ enabled: true, healthy: true, repositoryId: 'repo-a', blockers: null })
    ),
    http.get(operatorURL('restore-plans/:planId'), () => HttpResponse.json(restorePlan)),
    http.get(
      operatorURL('jobs/:jobId/events'),
      () => new HttpResponse('', { headers: { 'Content-Type': 'text/event-stream' } })
    )
  )
}

async function createPlan() {
  fireEvent.change(screen.getByLabelText('Recovery target'), {
    target: { value: '2026-07-13T09:30' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Preview restore impact' }))
  await screen.findByText('exact-plan-hash')
}

beforeEach(() => {
  routerMock.setCurrentUrl('/project/project-a/database/backups/scheduled')
  mockPolicyAndBackups()
})

describe('Backup Operator React Query options', () => {
  it('disables job and restore plan queries for empty URL parameters', () => {
    expect(operatorJobQueryOptions({ projectRef: 'project-a', jobId: '' }).enabled).toBe(false)
    expect(restorePlanQueryOptions({ projectRef: 'project-a', planId: '' }).enabled).toBe(false)
  })

  it('loads and validates policy and backup responses through the network boundary', async () => {
    const authorizationHeaders: Array<string | null> = []
    mswServer.use(
      http.get(operatorURL('policy'), ({ request }) => {
        authorizationHeaders.push(request.headers.get('authorization'))
        return HttpResponse.json(policy)
      }),
      http.get(operatorURL('backups'), ({ request }) => {
        authorizationHeaders.push(request.headers.get('authorization'))
        return HttpResponse.json(backups)
      })
    )
    const policyHook = customRenderHook(() =>
      useQuery(backupPolicyQueryOptions({ projectRef: 'project-a' }))
    )
    const backupsHook = customRenderHook(() =>
      useQuery(operatorBackupsQueryOptions({ projectRef: 'project-a' }))
    )
    await waitFor(() => expect(policyHook.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(backupsHook.result.current.isSuccess).toBe(true))
    expect(policyHook.result.current.data?.retentionDays).toBe(7)
    expect(backupsHook.result.current.data?.confidence).toBe('drill-verified')
    expect(backupsHook.result.current.data?.drill?.evidenceDigest).toBe('sha256:drill-evidence')
    expect(authorizationHeaders).toEqual([
      'Bearer platform-access-token',
      'Bearer platform-access-token',
    ])
  })

  it('surfaces schema drift as a query error', async () => {
    mswServer.use(
      http.get(operatorURL('policy'), () => HttpResponse.json({ ...policy, retentionDays: 0 }))
    )
    const hook = customRenderHook(() =>
      useQuery(backupPolicyQueryOptions({ projectRef: 'project-a' }))
    )
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
  })
})

describe('SelfPlatformBackupOperator', () => {
  it('does not request or render restore progress for an empty backupJob URL parameter', async () => {
    let jobRequests = 0
    routerMock.setCurrentUrl('/project/project-a/database/backups/scheduled?backupPlan=&backupJob=')
    mswServer.use(
      http.get(operatorURL('jobs/:jobId'), () => {
        jobRequests++
        return HttpResponse.json({ message: 'Job ID is required' }, { status: 400 })
      })
    )

    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)

    expect(await screen.findByText('Backup policy')).toBeInTheDocument()
    expect(jobRequests).toBe(0)
    expect(screen.queryByText('Failed to load restore progress')).not.toBeInTheDocument()
  })

  it('renders durable isolated restore drill evidence', async () => {
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    expect(await screen.findByText('Isolated restore drill')).toBeInTheDocument()
    expect(screen.getByText('Verified')).toBeInTheDocument()
    expect(screen.getByText('sha256:drill-evidence')).toBeInTheDocument()
    expect(await screen.findByText(/single-primary-pgbackrest/)).toBeInTheDocument()
    expect(await screen.findByText(/s3:\/\/backups/)).toBeInTheDocument()
  })

  it('starts a manual full backup and follows its durable job', async () => {
    mswServer.use(
      http.post(operatorURL('backups'), () =>
        HttpResponse.json({
          id: 'job-backup',
          type: 'backup',
          state: 'queued',
          progress: 0,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      ),
      http.get(operatorURL('jobs/job-backup'), () =>
        HttpResponse.json({
          id: 'job-backup',
          type: 'backup',
          state: 'running',
          progress: 20,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      )
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Start full backup' }))
    expect(await screen.findByText('Backup job job-backup')).toBeInTheDocument()
  })

  it('renders pending and error states explicitly', async () => {
    mswServer.use(
      http.get(operatorURL('policy'), async () => {
        await delay('infinite')
        return HttpResponse.json(policy)
      })
    )
    const pending = customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    expect(document.querySelector('.shimmering-loader')).toBeInTheDocument()
    pending.unmount()

    mockPolicyAndBackups()
    mswServer.use(
      http.get(operatorURL('policy'), () =>
        HttpResponse.json({ message: 'Operator offline' }, { status: 503 })
      )
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    expect(await screen.findByText('Failed to load the backup policy')).toBeInTheDocument()
  })

  it('renders empty, stale, and blocker states', async () => {
    mockPolicyAndBackups({
      backupsResponse: {
        ...backups,
        backups: [],
        isStale: true,
        blockers: ['Repository check failed.'],
      },
    })
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    expect(await screen.findByText('Backup observations are stale')).toBeInTheDocument()
    expect(screen.getByText('Repository check failed.')).toBeInTheDocument()
    expect(screen.getByText(/No backups have been observed yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview restore impact' })).toBeDisabled()
  })

  it('requires the exact plan hash before executing', async () => {
    const requests: string[] = []
    mswServer.use(
      http.post(operatorURL('restore-plans'), () => HttpResponse.json(restorePlan)),
      http.post(operatorURL('restore-plans/plan-1/confirm'), async ({ request }) => {
        requests.push(JSON.stringify(await request.json()))
        return HttpResponse.json({ confirmed: true })
      }),
      http.post(operatorURL('restore-plans/plan-1/execute'), () =>
        HttpResponse.json({
          id: 'job-1',
          type: 'restore',
          state: 'running',
          progress: 1,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      ),
      http.get(operatorURL('jobs/job-1'), () =>
        HttpResponse.json({
          id: 'job-1',
          type: 'restore',
          state: 'running',
          progress: 25,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      )
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await screen.findByText('Backup policy')
    await createPlan()
    const execute = screen.getByRole('button', { name: 'Confirm and execute restore' })
    expect(execute).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Exact restore plan hash'), 'wrong')
    expect(execute).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Exact restore plan hash'))
    await userEvent.type(screen.getByLabelText('Exact restore plan hash'), 'exact-plan-hash')
    await userEvent.click(execute)
    expect(await screen.findByText('Restore job job-1')).toBeInTheDocument()
    expect(requests).toEqual(['{"planHash":"exact-plan-hash"}'])
  })

  it('stops before execute when the AAL2 confirmation endpoint rejects', async () => {
    let executeRequests = 0
    mswServer.use(
      http.post(operatorURL('restore-plans'), () => HttpResponse.json(restorePlan)),
      http.post(operatorURL('restore-plans/plan-1/confirm'), () =>
        HttpResponse.json(
          {
            code: 'AAL2_REQUIRED',
            message: 'A recent AAL2 session is required',
            correlation_id: 'corr-aal2',
            retryable: false,
            details: {},
          },
          { status: 403 }
        )
      ),
      http.post(operatorURL('restore-plans/plan-1/execute'), () => {
        executeRequests++
        return HttpResponse.json({})
      })
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await screen.findByText('Backup policy')
    await createPlan()
    await userEvent.type(screen.getByLabelText('Exact restore plan hash'), 'exact-plan-hash')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and execute restore' }))
    await waitFor(() => expect(executeRequests).toBe(0))
    expect(await screen.findByText('Additional authentication required')).toBeInTheDocument()
    const setupMfa = screen.getByRole('button', { name: 'Set up MFA' })
    expect(screen.getByRole('button', { name: 'Confirm and execute restore' })).toBeDisabled()
    await userEvent.click(setupMfa)
    expect(routerMock.pathname).toBe('/account/security')
    expect(routerMock.query.returnTo).toContain('/project/project-a/database/backups/scheduled')
  })

  it('disables execution and explains when the restore plan has expired', async () => {
    const expiredPlan = { ...restorePlan, expiresAt: '2026-07-13T12:00:00Z' }
    const freshPlan = {
      ...restorePlan,
      id: 'plan-2',
      hash: 'fresh-plan-hash',
      expiresAt: '2099-07-13T12:00:00Z',
    }
    const createRequests: Array<{ recoveryTarget: string }> = []
    mswServer.use(
      http.post(operatorURL('restore-plans'), async ({ request }) => {
        createRequests.push((await request.json()) as { recoveryTarget: string })
        return HttpResponse.json(createRequests.length === 1 ? expiredPlan : freshPlan)
      }),
      http.get(operatorURL('restore-plans/plan-1'), () => HttpResponse.json(expiredPlan)),
      http.get(operatorURL('restore-plans/plan-2'), () => HttpResponse.json(freshPlan))
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await screen.findByText('Backup policy')
    fireEvent.change(screen.getByLabelText('Recovery target'), {
      target: { value: '2026-07-13T09:30' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Preview restore impact' }))

    expect(await screen.findByText('Restore plan expired')).toBeInTheDocument()
    expect(screen.queryByLabelText('Exact restore plan hash')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Confirm and execute restore' })
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate restore plan' }))

    expect(await screen.findByText('fresh-plan-hash')).toBeInTheDocument()
    expect(screen.getByLabelText('Exact restore plan hash')).toBeInTheDocument()
    expect(createRequests).toHaveLength(2)
    expect(createRequests.at(-1)).toEqual({
      recoveryTarget: new Date(expiredPlan.recoveryTarget).toISOString(),
    })
  })

  it('surfaces a non-AAL2 confirmation failure and stops before execute', async () => {
    let executeRequests = 0
    mswServer.use(
      http.post(operatorURL('restore-plans'), () => HttpResponse.json(restorePlan)),
      http.post(operatorURL('restore-plans/plan-1/confirm'), () =>
        HttpResponse.json(
          {
            code: 'restore_not_confirmable',
            message: 'restore plan is missing, stale, expired, or already confirmed',
            retryable: false,
          },
          { status: 409 }
        )
      ),
      http.post(operatorURL('restore-plans/plan-1/execute'), () => {
        executeRequests++
        return HttpResponse.json({})
      })
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await screen.findByText('Backup policy')
    await createPlan()
    await userEvent.type(screen.getByLabelText('Exact restore plan hash'), 'exact-plan-hash')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and execute restore' }))

    expect(await screen.findByText('Failed to start restore')).toBeInTheDocument()
    expect(executeRequests).toBe(0)
    expect(screen.queryByText('Additional authentication required')).not.toBeInTheDocument()
  })

  it('renders an orphaned job as a non-terminal takeover warning state', async () => {
    mswServer.use(
      http.post(operatorURL('restore-plans'), () => HttpResponse.json(restorePlan)),
      http.post(operatorURL('restore-plans/plan-1/confirm'), () =>
        HttpResponse.json({ confirmed: true })
      ),
      http.post(operatorURL('restore-plans/plan-1/execute'), () =>
        HttpResponse.json({
          id: 'job-orphan',
          type: 'restore',
          state: 'orphaned',
          progress: 40,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      ),
      http.get(operatorURL('jobs/job-orphan'), () =>
        HttpResponse.json({
          id: 'job-orphan',
          type: 'restore',
          state: 'orphaned',
          progress: 40,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      )
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await screen.findByText('Backup policy')
    await createPlan()
    await userEvent.type(screen.getByLabelText('Exact restore plan hash'), 'exact-plan-hash')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and execute restore' }))
    expect(await screen.findByText('Restore job job-orphan')).toBeInTheDocument()
    expect(screen.getByText('orphaned')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Roll back restore' })).not.toBeInTheDocument()
  })

  it('renders manual intervention diagnostics and an active rollback action', async () => {
    let rollbackRequests = 0
    mswServer.use(
      http.post(operatorURL('restore-plans'), () => HttpResponse.json(restorePlan)),
      http.post(operatorURL('restore-plans/plan-1/confirm'), () =>
        HttpResponse.json({ confirmed: true })
      ),
      http.post(operatorURL('restore-plans/plan-1/execute'), () =>
        HttpResponse.json({
          id: 'job-manual',
          type: 'restore',
          state: 'manual-intervention',
          progress: 80,
          updatedAt: new Date().toISOString(),
          rollbackUntil: new Date(Date.now() + 60_000).toISOString(),
          manualIntervention: {
            code: 'FENCE_RELEASE_FAILED',
            summary: 'Manual review required',
            safeAction: 'Keep the fence engaged.',
            runbookUrl: '/runbook',
          },
        })
      ),
      http.get(operatorURL('jobs/job-manual'), () =>
        HttpResponse.json({
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
        })
      ),
      http.post(operatorURL('jobs/job-manual/rollback'), () => {
        rollbackRequests++
        return HttpResponse.json({
          id: 'job-manual',
          type: 'rollback',
          state: 'running',
          progress: 0,
          updatedAt: new Date().toISOString(),
          rollbackUntil: null,
          manualIntervention: null,
        })
      })
    )
    customRender(<SelfPlatformBackupOperator projectRef="project-a" />)
    await screen.findByText('Backup policy')
    await createPlan()
    await userEvent.type(screen.getByLabelText('Exact restore plan hash'), 'exact-plan-hash')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and execute restore' }))
    expect(await screen.findByText('Manual review required')).toBeInTheDocument()
    expect(screen.getByText('Keep the fence engaged.')).toBeInTheDocument()
    const rollback = screen.getByRole('button', { name: 'Roll back restore' })
    expect(rollback).toBeEnabled()
    await userEvent.click(rollback)
    await waitFor(() => expect(rollbackRequests).toBe(1))
  })
})
