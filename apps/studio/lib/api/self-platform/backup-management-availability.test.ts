import { describe, expect, it } from 'vitest'

import { evaluateBackupManagementAvailability } from './backup-management-availability'

const correlationId = '00000000-0000-4000-8000-000000000019'

const binding = (overrides: Record<string, unknown> = {}) => ({
  state: 'active' as const,
  targetState: 'active' as const,
  allowedCapabilityPrefixes: ['backup.', 'runtime.'],
  domains: [
    {
      domain: 'backup-operator' as const,
      apiUrl: 'https://backup.example.test',
      audience: 'backup-operator',
      contractVersion: 'v1',
      capabilitySchemaPrefix: 'supabase.backup.',
      targetVersion: '0.1.1',
      state: 'available' as const,
      observedAt: '2026-07-16T00:00:00Z',
    },
  ],
  ...overrides,
})

describe('evaluateBackupManagementAvailability', () => {
  it('returns setup guidance when the project has no management binding', () => {
    expect(evaluateBackupManagementAvailability(null, correlationId)).toMatchObject({
      state: 'unconfigured',
      configured: false,
      blockers: [{ code: 'backup_management_unconfigured' }],
    })
  })

  it('rejects a binding without the backup capability prefix', () => {
    expect(
      evaluateBackupManagementAvailability(
        binding({ allowedCapabilityPrefixes: ['runtime.'] }),
        correlationId
      )
    ).toMatchObject({
      state: 'unauthorized',
      blockers: [{ code: 'backup_capability_not_allowed' }],
    })
  })

  it('rechecks a previously unavailable domain and preserves incompatible state', () => {
    expect(
      evaluateBackupManagementAvailability(
        binding({ domains: [{ ...binding().domains[0], state: 'unavailable' }] }),
        correlationId
      )
    ).toMatchObject({
      state: 'checking',
      configured: true,
      blockers: [{ code: 'backup_domain_rechecking' }],
    })
    expect(
      evaluateBackupManagementAvailability(
        binding({ domains: [{ ...binding().domains[0], state: 'incompatible' }] }),
        correlationId
      )
    ).toMatchObject({ state: 'incompatible', configured: true })
  })

  it('requires a readiness probe for unverified domains and accepts available domains', () => {
    expect(
      evaluateBackupManagementAvailability(
        binding({ domains: [{ ...binding().domains[0], state: 'unverified' }] }),
        correlationId
      )
    ).toMatchObject({ state: 'checking' })
    expect(evaluateBackupManagementAvailability(binding(), correlationId)).toEqual({
      state: 'available',
      configured: true,
      blockers: [],
      correlationId,
    })
  })
})
