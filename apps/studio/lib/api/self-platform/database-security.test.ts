import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rotateDatabasePassword } from './database-security'
import { executePlatformQuery } from './db'
import { getFleetOperation } from './fleet-operations'
import { requestManagementDomain } from './management-trust'

vi.mock('./attachment', () => ({ requireProjectCapability: vi.fn() }))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./fleet-operations', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fleet-operations')>()
  return { ...original, getFleetOperation: vi.fn() }
})
vi.mock('./management-trust', () => ({
  syncProjectManagementBinding: vi.fn().mockResolvedValue({
    id: 'binding-1',
    state: 'active',
    targetState: 'active',
    deploymentKind: 'compose',
    managementTargetId: 'target-1',
  }),
  requestManagementDomain: vi.fn(),
}))
vi.mock('./projects', () => ({
  getProjectByRef: vi.fn().mockResolvedValue({
    ref: 'project-a',
    db_pass_enc: 'enc-current',
    db_pass_readonly_enc: 'enc-readonly',
  }),
}))
vi.mock('./secrets', () => ({
  decryptSecret: vi.fn((value: string) =>
    value === 'enc-current' ? 'current-password-value' : 'readonly-password-value'
  ),
  encryptSecret: vi.fn(() => 'enc-next'),
}))

const policyRow = {
  generation: 2,
  ssl_enforced: false,
  tls_ca_reference: null,
  allowed_cidrs: [],
  default_pool_size: 15,
  max_client_connections: 200,
  state: 'ready',
  operation_id: null,
  error_code: null,
  observed_at: null,
}

function operation(id: string) {
  const now = new Date().toISOString()
  return {
    id,
    projectRef: 'project-a',
    targetId: 'target-1',
    bindingId: 'binding-1',
    domain: 'fleet.database',
    capability: 'database.security.reconcile',
    state: 'succeeded' as const,
    protocolMajor: 1,
    protocolMinor: 0,
    expectedGeneration: 3,
    desiredRevision: '3bc8e584-860d-4e6e-92f4-c075e962f38e',
    desiredDigest: 'a'.repeat(64),
    inputSchema: 'supabase.fleet.database.security.reconcile.v1',
    fencingToken: 1,
    attempts: 1,
    correlationId: 'correlation-1',
    deadlineAt: now,
    attemptHistory: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe('Fleet database password rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executePlatformQuery).mockImplementation(async ({ query }) => {
      if (query.includes('insert into platform.database_security_policies(project_ref) values')) {
        return { data: [policyRow], error: undefined }
      }
      if (query.includes("state, operation_id)\n      values ($1, 1, 'applying'")) {
        return { data: [{ generation: 3 }], error: undefined }
      }
      return { data: [], error: undefined }
    })
    vi.mocked(requestManagementDomain).mockImplementation(async (_binding, _domain, request) => {
      const id = (request.body as { operationId: string }).operationId
      return operation(id)
    })
    vi.mocked(getFleetOperation).mockImplementation(async ({ operationId }) =>
      operation(operationId)
    )
  })

  it('updates the platform connection only after success and never returns either password', async () => {
    const result = await rotateDatabasePassword({
      projectRef: 'project-a',
      value: { expectedGeneration: 2, role: 'primary', newPassword: 'next-password-value' },
      idempotencyKey: 'password-rotation-1',
      actor: 'user-1',
      correlationId: 'correlation-1',
    })

    const request = vi.mocked(requestManagementDomain).mock.calls[0][2]
    expect(request.body).toMatchObject({
      capability: 'database.security.reconcile',
      typedInput: {
        rotation: {
          role: 'primary',
          currentPassword: 'current-password-value',
          newPassword: 'next-password-value',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('current-password-value')
    expect(JSON.stringify(result)).not.toContain('next-password-value')

    const platformSecretUpdate = vi
      .mocked(executePlatformQuery)
      .mock.calls.find(([value]) =>
        value.query.includes('update platform.projects set db_pass_enc')
      )
    expect(platformSecretUpdate?.[0].parameters).toEqual(['project-a', 'enc-next', ['db_pass_enc']])
  })
})
