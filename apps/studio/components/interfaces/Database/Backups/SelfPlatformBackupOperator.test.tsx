import { useQuery } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SelfPlatformBackupOperator } from './SelfPlatformBackupOperator'

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: vi.fn(),
}))

describe('SelfPlatformBackupOperator', () => {
  it('shows a configuration blocker without starting inventory queries', () => {
    vi.mocked(useQuery).mockReturnValue({
      data: {
        configured: false,
        policy: { enabled: false, retentionDays: null, schedule: null, backupFrom: null },
        provider: { name: 'pgBackRest', version: null },
        topology: { kind: 'unknown', primary: null, standbys: 0 },
        repository: { type: null, location: null },
        check: {
          status: 'unknown',
          checkedAt: null,
          message: 'No Backup Operator status has been published',
        },
        lastJob: null,
        capabilities: {
          backup: false,
          restore: false,
          blockers: ['Install and enroll the Backup Operator before enabling PITR'],
        },
        compatibility: { image: null, supported: false, blocker: null },
        updatedAt: null,
        management: {
          state: 'available',
          configured: true,
          blockers: [],
          correlationId: '00000000-0000-4000-8000-000000000001',
        },
      },
      isPending: false,
      isError: false,
    } as ReturnType<typeof useQuery>)

    render(<SelfPlatformBackupOperator projectRef="project-a" />)

    expect(screen.getByText('Backup Operator is not configured')).toBeInTheDocument()
    expect(
      screen.getByText('Install and enroll the Backup Operator before enabling PITR')
    ).toBeInTheDocument()
    expect(useQuery).toHaveBeenCalledOnce()
  })
})
