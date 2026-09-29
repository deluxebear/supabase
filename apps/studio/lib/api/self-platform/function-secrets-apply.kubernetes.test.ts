import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import { commitDesiredConfiguration } from './desired-state'
import { applyFunctionSecrets, getFunctionSecretsApplyStatus } from './function-secrets-apply'
import { getAgentSecretRecipient, getProjectManagementBinding } from './management-trust'
import { sealedSecretKeyId } from './sealed-secret'

vi.mock('./attachment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attachment')>()),
  requireProjectCapability: vi.fn(),
}))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./desired-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./desired-state')>()),
  commitDesiredConfiguration: vi.fn(),
}))
vi.mock('./management-trust', () => ({
  getProjectManagementBinding: vi.fn(),
  getAgentSecretRecipient: vi.fn(),
}))
vi.mock('./ownership-policy', () => ({
  listProjectOwnershipPolicies: vi
    .fn()
    .mockResolvedValue([
      { domain: 'functions', ownershipMode: 'direct-managed', policyRevision: 1, casToken: 'x' },
    ]),
  setProjectOwnershipPolicy: vi.fn(),
}))
vi.mock('./function-secrets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./function-secrets')>()),
  readFunctionSecretValues: vi.fn().mockResolvedValue({ STRIPE_KEY: 'sk_live_hunter2' }),
}))
vi.mock('./secrets', () => ({ requirePlatformEncryptionKey: () => 'studio-key' }))

const publicKey = (
  generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer
).subarray(12)
const request = { actor: 'user-1', correlationId: 'correlation-1' }

beforeEach(() => {
  vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
  vi.mocked(commitDesiredConfiguration).mockReset()
  vi.mocked(getProjectManagementBinding).mockResolvedValue({
    id: 'binding-1',
    projectRef: 'project-a',
    state: 'active',
    targetState: 'active',
    deploymentKind: 'kubernetes',
    managementTargetId: 'target-1',
  } as never)
  vi.mocked(getAgentSecretRecipient).mockResolvedValue({
    keyId: sealedSecretKeyId(publicKey),
    publicKey,
  })
})

describe('Edge Function secrets on Kubernetes targets', () => {
  it('commits a sealed Secret for the functions Deployment and no Compose files', async () => {
    const status = await getFunctionSecretsApplyStatus('project-a', request)
    expect(status).toMatchObject({
      availability: { isAvailable: true },
      state: 'pending',
      sealedSecretNames: ['STRIPE_KEY'],
    })

    await applyFunctionSecrets({
      projectRef: 'project-a',
      expectedGeneration: 0,
      confirmOwnership: false,
      idempotencyKey: 'key-1',
      ...request,
    })
    const committed = vi.mocked(commitDesiredConfiguration).mock.calls[0][0]
    expect(committed.desiredDocument).toMatchObject({
      adapter: 'kubernetes',
      kubernetes: {
        resources: [],
        secrets: [
          {
            service: 'functions',
            sealed: { envelope: { recipientKeyId: sealedSecretKeyId(publicKey) } },
          },
        ],
      },
    })
    expect(committed.desiredDocument).not.toHaveProperty('compose')
    expect(JSON.stringify(committed.desiredDocument)).not.toContain('hunter2')
  })

  it('is unavailable without an Agent key instead of dropping the secrets', async () => {
    vi.mocked(getAgentSecretRecipient).mockResolvedValue(null)
    const status = await getFunctionSecretsApplyStatus('project-a', request)
    expect(status.availability).toMatchObject({
      isAvailable: false,
      code: 'secret_recipient_unavailable',
    })
    expect(status.skippedSecretNames).toEqual(['STRIPE_KEY'])
    await expect(
      applyFunctionSecrets({
        projectRef: 'project-a',
        expectedGeneration: 0,
        confirmOwnership: false,
        idempotencyKey: 'key-2',
        ...request,
      })
    ).rejects.toMatchObject({ code: 'apply_unavailable' })
    expect(commitDesiredConfiguration).not.toHaveBeenCalled()
  })

  it('says a failed key lookup is temporary instead of asking for an Agent upgrade', async () => {
    vi.mocked(getAgentSecretRecipient).mockRejectedValue(new Error('Fleet Control unavailable'))
    const status = await getFunctionSecretsApplyStatus('project-a', request)
    expect(status.availability).toMatchObject({
      isAvailable: false,
      code: 'secret_recipient_lookup_failed',
    })
    if (!status.availability.isAvailable) {
      expect(status.availability.message).not.toContain('Upgrade')
    }
    await expect(
      applyFunctionSecrets({
        projectRef: 'project-a',
        expectedGeneration: 0,
        confirmOwnership: false,
        idempotencyKey: 'key-3',
        ...request,
      })
    ).rejects.toThrow('Fleet Control unavailable')
  })
})
