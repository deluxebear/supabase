import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CONNECTION_SOURCE_LOAD_BALANCER } from '../Connect.constants'
import { useConnectionStringDatabases } from '../useConnectionStringDatabases'

const state = vi.hoisted(() => ({
  profile: 'fleet',
  isHighAvailability: false,
  hasDedicatedPooler: true,
}))

const deploymentMode = { isPlatform: true, isSelfHosted: false, isCli: false }

vi.mock('common', () => ({ useParams: () => ({ ref: 'project-a' }) }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  get STUDIO_DEPLOYMENT_PROFILE() {
    return state.profile
  },
}))
vi.mock('@/hooks/misc/useSelectedProject', () => ({
  useIsHighAvailability: () => state.isHighAvailability,
}))
vi.mock('@/hooks/misc/useCheckEntitlements', () => ({
  useCheckEntitlements: () => ({ hasAccess: state.hasDedicatedPooler }),
}))
vi.mock('@/data/read-replicas/replicas-query', () => ({
  useReadReplicasQuery: () => ({
    data: [
      {
        identifier: 'project-a',
        db_host: 'db.example.com',
        db_port: 5432,
        db_name: 'postgres',
        db_user: 'postgres',
      },
    ],
  }),
}))
vi.mock('@/data/database/pgbouncer-config-query', () => ({
  usePgbouncerConfigQuery: () => ({
    data: {
      connection_string:
        'postgresql://postgres:[YOUR-PASSWORD]@dedicated.example.com:6543/postgres',
      db_host: 'dedicated.example.com',
      db_port: 6543,
      db_name: 'postgres',
      db_user: 'postgres',
    },
  }),
}))
vi.mock('@/data/database/supavisor-configuration-query', () => ({
  useSupavisorConfigurationQuery: () => ({
    data: [
      // Session first catches accidentally selecting a pooler by identifier alone.
      {
        identifier: 'project-a',
        pool_mode: 'session',
        connection_string:
          'postgresql://postgres.project-a:[YOUR-PASSWORD]@session.example.com:5439/postgres',
        db_host: 'session.example.com',
        db_port: 5439,
        db_name: 'postgres',
        db_user: 'postgres.project-a',
      },
      {
        identifier: 'project-a',
        pool_mode: 'transaction',
        connection_string:
          'postgresql://postgres.project-a:[YOUR-PASSWORD]@transaction.example.com:6549/postgres',
        db_host: 'transaction.example.com',
        db_port: 6549,
        db_name: 'postgres',
        db_user: 'postgres.project-a',
      },
    ],
  }),
}))
vi.mock('@/data/subscriptions/project-addons-query', () => ({
  useProjectAddonsQuery: () => ({ data: { selected_addons: [] } }),
}))
vi.mock('@/components/interfaces/Billing/Subscription/Subscription.utils', () => ({
  getAddons: () => ({ ipv4: undefined }),
}))

describe('useConnectionStringDatabases upstream integration', () => {
  beforeEach(() => {
    state.profile = 'fleet'
    state.isHighAvailability = false
    state.hasDedicatedPooler = true
  })

  it('preserves Fleet transaction and session endpoints without fabricating a dedicated pooler', () => {
    const { result } = renderHook(() => useConnectionStringDatabases(deploymentMode))
    expect(result.current['project-a'].transactionShared).toContain('transaction.example.com:6549')
    expect(result.current['project-a'].sessionShared).toContain('session.example.com:5439')
    expect(result.current['project-a'].transactionDedicated).toBeUndefined()
  })

  it('retains the dedicated pooler for entitled cloud projects', () => {
    state.profile = 'cloud'
    const { result } = renderHook(() => useConnectionStringDatabases(deploymentMode))
    expect(result.current['project-a'].transactionDedicated).toContain('dedicated.example.com:6543')
  })

  it('does not expose a dedicated pooler without the entitlement', () => {
    state.profile = 'cloud'
    state.hasDedicatedPooler = false
    const { result } = renderHook(() => useConnectionStringDatabases(deploymentMode))
    expect(result.current['project-a'].transactionDedicated).toBeUndefined()
  })

  it('retains the upstream HA read-only load balancer connection', () => {
    state.profile = 'cloud'
    state.isHighAvailability = true
    const { result } = renderHook(() => useConnectionStringDatabases(deploymentMode))
    expect(result.current[CONNECTION_SOURCE_LOAD_BALANCER].direct).toContain('db.example.com:5433')
    expect(result.current[CONNECTION_SOURCE_LOAD_BALANCER].direct).toContain(
      'sslnegotiation=direct'
    )
  })
})
