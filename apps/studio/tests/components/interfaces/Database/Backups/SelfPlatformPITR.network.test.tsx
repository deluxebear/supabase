import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelfPlatformPITR } from '@/components/interfaces/Database/Backups/SelfPlatformPITR'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  getAccessToken: vi.fn().mockResolvedValue('platform-access-token'),
}))

const backupState = {
  backups: [],
  recoveryWindow: {
    earliest: '2026-07-13T09:00:00Z',
    latest: '2026-07-14T10:00:00Z',
  },
  confidence: 'drill-verified',
  isStale: false,
  blockers: [] as string[],
  drill: null,
}

const availableStatus = {
  configured: true,
  policy: {
    enabled: true,
    retentionDays: 7,
    schedule: '0 1 * * *',
    backupFrom: 'primary',
  },
  provider: { name: 'pgBackRest', version: '2.56' },
  topology: { kind: 'static-primary', primary: 'primary-a', standbys: 0 },
  repository: { type: 's3', location: 's3://backups' },
  check: { status: 'healthy', checkedAt: '2026-07-13T10:00:00Z', message: null },
  lastJob: null,
  capabilities: { backup: true, restore: true, blockers: [] },
  compatibility: { image: 'postgres:17', supported: true, blocker: null },
  updatedAt: '2026-07-13T10:00:00Z',
  management: {
    state: 'available',
    configured: true,
    blockers: [],
    correlationId: '00000000-0000-4000-8000-000000000019',
  },
}

function operatorURL(path: string) {
  return `*/api/platform/database/project-a/backup-operator/${path}`
}

function mockOperator({
  pitr = {
    enabled: true,
    healthy: true,
    repositoryId: 'compose-repo',
    blockers: null,
  },
  backups = backupState,
}: {
  pitr?: {
    enabled: boolean
    healthy: boolean
    repositoryId: string | null
    blockers: string[] | null
  }
  backups?: typeof backupState
} = {}) {
  mswServer.use(
    http.get(operatorURL('status'), () => HttpResponse.json(availableStatus)),
    http.get(operatorURL('pitr'), () => HttpResponse.json(pitr)),
    http.get(operatorURL('backups'), () => HttpResponse.json(backups))
  )
}

beforeEach(() => {
  routerMock.setCurrentUrl('/project/project-a/database/backups/pitr')
})

describe('SelfPlatformPITR', () => {
  it('renders the operator recovery window when PITR is healthy', async () => {
    mockOperator()
    customRender(<SelfPlatformPITR projectRef="project-a" />)

    expect(await screen.findByText('Point-in-time recovery')).toBeInTheDocument()
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByText('compose-repo')).toBeInTheDocument()
    expect(screen.getByText('drill-verified')).toBeInTheDocument()
    expect(screen.getByText('Earliest recoverable time')).toBeInTheDocument()
    expect(screen.getByText('Latest recoverable time')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open restore controls' })).toHaveAttribute(
      'href',
      '/project/project-a/database/backups/scheduled'
    )
    expect(screen.queryByText('Point-in-time recovery is not configured')).not.toBeInTheDocument()
  })

  it('only reports PITR as unconfigured when the operator disables it', async () => {
    mockOperator({
      pitr: { enabled: false, healthy: false, repositoryId: null, blockers: null },
    })
    customRender(<SelfPlatformPITR projectRef="project-a" />)

    expect(await screen.findByText('Point-in-time recovery is not configured')).toBeInTheDocument()
  })

  it('renders operator blockers instead of a healthy state', async () => {
    mockOperator({
      pitr: {
        enabled: true,
        healthy: false,
        repositoryId: 'compose-repo',
        blockers: ['WAL recovery coverage has not been observed'],
      },
    })
    customRender(<SelfPlatformPITR projectRef="project-a" />)

    expect(await screen.findByText('Point-in-time recovery is blocked')).toBeInTheDocument()
    expect(screen.getByText('WAL recovery coverage has not been observed')).toBeInTheDocument()
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument()
  })
})
