import { describe, expect, it } from 'vitest'

import {
  jwtConfigurationInputSchema,
  renderJWTOverride,
  verifyLegacyJWT,
} from './jwt-configuration'
import { mintServiceJwt } from './mint-jwt'
import { openSecret, sealSecret, studioObservationRecipient } from './sealed-secret'

describe('Fleet JWT configuration', () => {
  it('updates all JWT consumers and regenerates only legacy credentials', () => {
    const input = { secret: 'x'.repeat(32), anonKey: 'anon', serviceKey: 'service' }
    const document = JSON.parse(renderJWTOverride(input))
    expect(Object.keys(document.services)).toEqual([
      'auth',
      'rest',
      'storage',
      'realtime',
      'functions',
      'supavisor',
      'kong',
    ])
    expect(document.services.auth.environment.GOTRUE_JWT_SECRET).toBe(input.secret)
    expect(document.services.rest.environment.PGRST_JWT_SECRET).toBe(input.secret)
    expect(document.services.storage.environment.SERVICE_KEY).toBe(input.serviceKey)
    expect(document.services.functions.environment.SUPABASE_SERVICE_ROLE_KEY).toBe(input.serviceKey)
    expect(document.services.kong.environment.SUPABASE_ANON_KEY).toBe(input.anonKey)
  })
  it('checks token signature, role and expiry', () => {
    const secret = 'x'.repeat(32),
      token = mintServiceJwt(secret, 'anon', 60)
    expect(verifyLegacyJWT(token, secret, 'anon')).toBe(true)
    expect(verifyLegacyJWT(token, 'wrong', 'anon')).toBe(false)
    expect(verifyLegacyJWT(token, secret, 'service_role')).toBe(false)
    expect(verifyLegacyJWT(token, secret, 'anon', Date.now() + 120_000)).toBe(false)
    expect(verifyLegacyJWT(token + 'wrong', secret, 'anon')).toBe(false)
  })
  it('opens observations only for their Studio recipient and binding', () => {
    const recipient = studioObservationRecipient('test-studio-key')
    const context = {
      projectRef: 'project-a',
      bindingId: 'binding-a',
      domain: 'jwt-observation',
      path: 'runtime.json',
    }
    const envelope = sealSecret({
      recipientPublicKey: recipient.publicKey,
      context,
      plaintext: 'private-value',
    })
    expect(JSON.stringify(envelope)).not.toContain('private-value')
    expect(openSecret({ recipientPrivateKey: recipient.privateKey, context, envelope })).toBe(
      'private-value'
    )
    expect(() =>
      openSecret({
        recipientPrivateKey: recipient.privateKey,
        context: { ...context, projectRef: 'project-b' },
        envelope,
      })
    ).toThrow()
    expect(() =>
      openSecret({
        recipientPrivateKey: studioObservationRecipient('other').privateKey,
        context,
        envelope,
      })
    ).toThrow()
  })
  it('requires explicit invalidation confirmation and rejects malformed secrets', () => {
    const input = {
      secret: 'x'.repeat(32),
      expectedGeneration: 0,
      confirmOwnership: true,
      confirmTokenInvalidation: true,
    }
    expect(jwtConfigurationInputSchema.safeParse(input).success).toBe(true)
    for (const secret of ['', 'short', 'x'.repeat(32) + '\n', 'x'.repeat(32) + '\0'])
      expect(jwtConfigurationInputSchema.safeParse({ ...input, secret }).success).toBe(false)
    expect(
      jwtConfigurationInputSchema.safeParse({ ...input, confirmTokenInvalidation: false }).success
    ).toBe(false)
  })
})
