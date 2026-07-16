import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import { getFleetOperation } from './fleet-operations'
import { requestManagementDomain, syncProjectManagementBinding } from './management-trust'
import { getRuntimeInventory } from './runtime-inventory'

vi.mock('./attachment', () => ({ requireProjectCapability: vi.fn() }))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./fleet-operations', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fleet-operations')>()
  return { ...original, getFleetOperation: vi.fn() }
})
vi.mock('./management-trust', () => ({
  syncProjectManagementBinding: vi.fn(),
  requestManagementDomain: vi.fn(),
}))

const evidence = {
  schema: 'supabase.fleet.runtime.observe.evidence.v1' as const,
  adapter: 'compose' as const,
  status: 'healthy' as const,
  observedGeneration: 1,
  observedAt: new Date().toISOString(),
  disk: {
    filesystemSizeBytes: 1000,
    filesystemUsedBytes: 400,
    filesystemAvailableBytes: 600,
    databaseBytes: 250,
    walBytes: 50,
    systemBytes: 100,
  },
  compute: { cpuCores: 4, memoryBytes: 8_000_000_000, source: 'compose-host-pool' },
  containers: [
    {
      service: 'db',
      name: 'project-db',
      image: 'supabase/postgres:17.6',
      imageId: 'sha256:db',
      state: 'running',
      health: 'healthy',
      cpuCores: 0,
      memoryBytes: 0,
    },
  ],
  volumes: [{ name: 'project-db', driver: 'local', usedBytes: 400 }],
  versions: [
    {
      service: 'db',
      version: '17.6',
      image: 'supabase/postgres:17.6',
      state: 'running',
      health: 'healthy',
    },
  ],
  upgrade: {
    currentPostgresVersion: '17.6',
    currentImage: 'supabase/postgres:17.6',
    latestSupportedVersion: '17.6',
    targetVersions: [],
    eligible: false,
    checks: [{ code: 'provider_registration', state: 'blocked' as const, message: 'blocked' }],
    blockers: [{ code: 'provider_not_registered', message: 'blocked', remediation: 'install' }],
    plan: ['plan'],
    rollback: ['rollback'],
    recovery: ['recover'],
    progress: 'idle',
  },
}

function operation() {
  const now = new Date().toISOString()
  return {
    id: 'inventory-op',
    projectRef: 'project-a',
    targetId: 'target-a',
    bindingId: 'binding-a',
    domain: 'fleet.runtime',
    capability: 'runtime.observe',
    state: 'succeeded' as const,
    protocolMajor: 1,
    protocolMinor: 0,
    expectedGeneration: 1,
    desiredRevision: '11111111-1111-4111-8111-111111111111',
    desiredDigest: 'a'.repeat(64),
    inputSchema: 'supabase.fleet.runtime.observe.v1',
    fencingToken: 1,
    evidenceSchema: 'supabase.fleet.runtime.observe.evidence.v1',
    evidence,
    attempts: 1,
    correlationId: 'correlation-a',
    deadlineAt: now,
    attemptHistory: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe('Fleet runtime inventory projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(syncProjectManagementBinding).mockResolvedValue({
      id: 'binding-a',
      projectRef: 'project-a',
      managementTargetId: 'target-a',
      deploymentKind: 'compose',
      state: 'active',
      targetState: 'active',
    } as never)
    vi.mocked(requestManagementDomain).mockResolvedValue(operation())
    vi.mocked(getFleetOperation).mockResolvedValue(operation())
    vi.mocked(executePlatformQuery).mockImplementation(async ({ query }) => {
      if (query.includes('returning generation, state, evidence'))
        return {
          data: [
            {
              generation: 0,
              state: 'pending',
              evidence: null,
              error_code: null,
              observed_at: null,
            },
          ],
          error: undefined,
        }
      if (query.includes('returning generation'))
        return { data: [{ generation: 1 }], error: undefined }
      return { data: [], error: undefined }
    })
  })

  it('refreshes capability liveness, executes one typed operation, and stores evidence', async () => {
    const result = await getRuntimeInventory({
      projectRef: 'project-a',
      actor: 'user-a',
      correlationId: 'correlation-a',
      force: true,
    })

    expect(result.disk.databaseBytes).toBe(250)
    expect(syncProjectManagementBinding).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'project-a', actor: 'user-a' })
    )
    expect(requestManagementDomain).toHaveBeenCalledWith(
      expect.anything(),
      'fleet-control',
      expect.objectContaining({
        body: expect.objectContaining({
          capability: 'runtime.observe',
          inputSchema: 'supabase.fleet.runtime.observe.v1',
          typedInput: { services: [] },
        }),
      })
    )
    expect(
      vi
        .mocked(executePlatformQuery)
        .mock.calls.some(([value]) => value.query.includes("state = 'ready', evidence = $3::jsonb"))
    ).toBe(true)
  })
})
