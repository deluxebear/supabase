import { beforeEach, expect, it, vi } from 'vitest'

import { mutateManagedAPIKeys } from './api-key-management'
import { executePlatformQuery } from './db'
import { readVerifiedJWTObservation } from './jwt-configuration'
import { commitServiceConfigApply, loadServiceConfigApplyPlan } from './service-config-apply'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./jwt-configuration', () => ({ readVerifiedJWTObservation: vi.fn() }))
vi.mock('./resolve-connection', () => ({
  resolveProjectConnection: vi
    .fn()
    .mockResolvedValue({ anonKey: 'a', serviceKey: 's', publishableKey: null, secretKey: null }),
}))
vi.mock('../self-hosted/util', () => ({ assertSelfHosted: vi.fn() }))
vi.mock('./secrets', () => ({ encryptSecret: () => 'encrypted', decryptSecret: () => '[]' }))
vi.mock('./service-config-apply', async (original) => ({
  ...(await original<object>()),
  loadServiceConfigApplyPlan: vi.fn(),
  commitServiceConfigApply: vi.fn(),
}))
beforeEach(() => vi.clearAllMocks())
const request = {
  projectRef: 'project-d',
  request: { actor: 'owner', correlationId: 'test' },
  idempotencyKey: 'request',
  change: { kind: 'create' as const, input: { type: 'publishable' as const, name: 'test' } },
}
it('rejects a running prior mutation before reading or replacing its keys', async () => {
  vi.mocked(executePlatformQuery).mockImplementation(async ({ query }) => ({
    data: query.includes('select desired.generation') ? [{ generation: 1, state: 'running' }] : [],
    error: undefined,
  }))
  await expect(mutateManagedAPIKeys(request)).rejects.toThrow('already updating')
  expect(loadServiceConfigApplyPlan).not.toHaveBeenCalled()
})
it('rejects a generation change while planning rather than losing a concurrent key', async () => {
  vi.mocked(executePlatformQuery).mockImplementation(async ({ query }) => ({
    data: query.includes('select desired.generation') ? [{ generation: 1, state: 'applied' }] : [],
    error: undefined,
  }))
  vi.mocked(readVerifiedJWTObservation).mockResolvedValue({
    credentials: { apiKeysGateway: true, gatewayAPIKeysManaged: false },
  } as never)
  vi.mocked(loadServiceConfigApplyPlan).mockResolvedValue({
    expectedGeneration: 2,
    secretsPlan: {},
  } as never)
  await expect(mutateManagedAPIKeys(request)).rejects.toThrow('desired configuration changed')
  expect(commitServiceConfigApply).not.toHaveBeenCalled()
})
