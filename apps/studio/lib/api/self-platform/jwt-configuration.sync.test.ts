import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import { syncJWTConfiguration } from './jwt-configuration'
import { getAgentJWTObservation } from './management-trust'
import { mintServiceJwt } from './mint-jwt'
import { sealSecret, studioObservationRecipient } from './sealed-secret'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./management-trust', () => ({ getAgentJWTObservation: vi.fn() }))
vi.mock('./resolve-connection', () => ({
  resolveProjectConnection: vi.fn().mockResolvedValue({
    jwtSecret: 'old',
    anonKey: 'old-anon',
    serviceKey: 'old-service',
    row: { key_mode: 'legacy-jwt', jwt_secret_enc: 'old-ciphertext' },
  }),
}))
vi.mock('./secrets', () => ({
  requirePlatformEncryptionKey: () => 'studio-key',
  encryptSecret: (value: string) => `encrypted:${value}`,
}))

function report(
  input: { projectRef?: string; bindingId?: string; observedAt?: string; serviceRole?: string } = {}
) {
  const projectRef = input.projectRef ?? 'project-a',
    bindingId = input.bindingId ?? 'binding-a'
  const secret = 's'.repeat(32),
    observedAt = input.observedAt ?? new Date().toISOString()
  const credentials = {
    secret,
    anonKey: mintServiceJwt(secret, 'anon', 3600),
    serviceKey: mintServiceJwt(secret, input.serviceRole ?? 'service_role', 3600),
    observedAt,
  }
  const envelope = sealSecret({
    recipientPublicKey: studioObservationRecipient('studio-key').publicKey,
    context: { projectRef, bindingId, domain: 'jwt-observation', path: 'runtime.json' },
    plaintext: JSON.stringify(credentials),
  })
  return {
    binding: { id: 'binding-a' },
    observation: {
      schema: 'supabase.fleet.jwt.observation.v1',
      projectRef,
      bindingId,
      observedAt,
      sealed: envelope,
    },
  }
}

beforeEach(() => {
  vi.mocked(executePlatformQuery).mockReset().mockResolvedValue({ data: [], error: undefined })
  vi.mocked(getAgentJWTObservation).mockReset()
})

describe('JWT runtime synchronization', () => {
  it('updates only encrypted registered credentials using a binding-scoped compare-and-swap', async () => {
    const value = report()
    vi.mocked(getAgentJWTObservation).mockResolvedValue(value as never)
    expect(await syncJWTConfiguration('project-a')).toBe(value.observation.observedAt)
    const query = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(query.query).toContain('jwt_secret_enc is not distinct from $6')
    expect(query.query).toContain('project_management_bindings')
    expect(query.parameters?.[1]).toBe('encrypted:' + 's'.repeat(32))
    expect(query.parameters?.[6]).toBe('binding-a')
  })
  it.each([
    { projectRef: 'project-b' },
    { bindingId: 'binding-b' },
    { observedAt: new Date(Date.now() - 180_000).toISOString() },
    { observedAt: new Date(Date.now() + 180_000).toISOString() },
    { serviceRole: 'anon' },
  ])('does not update invalid or stale reports: %j', async (input) => {
    vi.mocked(getAgentJWTObservation).mockResolvedValue(report(input) as never)
    expect(await syncJWTConfiguration('project-a')).toBeNull()
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })
  it('does not clear credentials when an agent has no observation', async () => {
    vi.mocked(getAgentJWTObservation).mockResolvedValue(null)
    expect(await syncJWTConfiguration('project-a')).toBeNull()
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })
})
