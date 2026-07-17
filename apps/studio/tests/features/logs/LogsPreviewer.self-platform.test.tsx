import { screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { LogsTableName } from '@/components/interfaces/Settings/Logs/Logs.constants'
import { LogsPreviewer } from '@/components/interfaces/Settings/Logs/LogsPreviewer'
import { customRender } from '@/tests/lib/custom-render'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))

vi.mock('@/data/projects/project-detail-query', () => ({
  useProjectDetailQuery: () => ({
    data: {
      self_platform: {
        logflare_url: null,
        secrets_set: { logflare_token: false },
      },
    },
    isPending: false,
  }),
}))

vi.mock('@/components/interfaces/Settings/Logs/LogTable', () => ({
  LogTable: ({ EmptyState }: { EmptyState?: ReactNode }) => <div>{EmptyState}</div>,
}))

describe('LogsPreviewer in Fleet', () => {
  test('renders the configuration empty state when analytics is unavailable', () => {
    customRender(
      <LogsPreviewer queryType="api" projectRef="project-b" tableName={LogsTableName.EDGE} />
    )

    expect(screen.getByText('Logs are not configured')).toBeInTheDocument()
  })
})
