import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { sealedSecretFingerprint, type SealedSecretContext } from './sealed-secret'
import {
  deriveServiceConfigApplyState,
  kubernetesSecretsPlaintext,
  plainFilesKey,
  sealedSecretsFile,
  sealedSecretsMarker,
  type ServiceConfigApplyOperation,
} from './service-config-apply'

const operation = (state: string): ServiceConfigApplyOperation => ({
  id: 'auth_apply_1',
  state,
  errorCode: null,
  updatedAt: '2026-09-28T00:00:00Z',
})

describe('deriveServiceConfigApplyState', () => {
  const planned = 'services:\n  auth:\n    environment: {}\n'

  it('reports nothing to apply before anything was stored or applied', () => {
    expect(
      deriveServiceConfigApplyState({
        plannedPlain: planned,
        plannedSecrets: null,
        desiredSecrets: null,
        hasSettings: false,
        desiredPlain: null,
        operation: null,
      })
    ).toBe('nothing-to-apply')
  })

  it('reports pending when stored settings differ from the desired revision', () => {
    expect(
      deriveServiceConfigApplyState({
        plannedPlain: planned,
        plannedSecrets: null,
        desiredSecrets: null,
        hasSettings: true,
        desiredPlain: null,
        operation: null,
      })
    ).toBe('pending')
    expect(
      deriveServiceConfigApplyState({
        plannedPlain: planned,
        plannedSecrets: null,
        desiredSecrets: null,
        hasSettings: true,
        desiredPlain: 'older',
        operation: operation('applied'),
      })
    ).toBe('pending')
  })

  it('reports cleared overrides as pending so they can be applied', () => {
    expect(
      deriveServiceConfigApplyState({
        plannedPlain: planned,
        plannedSecrets: null,
        desiredSecrets: null,
        hasSettings: false,
        desiredPlain: 'older',
        operation: null,
      })
    ).toBe('pending')
  })

  it('follows the operation for the current revision', () => {
    const base = {
      plannedPlain: planned,
      plannedSecrets: null,
      hasSettings: true,
      desiredPlain: planned,
      desiredSecrets: null,
    }
    expect(deriveServiceConfigApplyState({ ...base, operation: operation('queued') })).toBe(
      'applying'
    )
    expect(deriveServiceConfigApplyState({ ...base, operation: operation('applied') })).toBe(
      'applied'
    )
    expect(deriveServiceConfigApplyState({ ...base, operation: operation('failed') })).toBe(
      'failed'
    )
    expect(deriveServiceConfigApplyState({ ...base, operation: operation('superseded') })).toBe(
      'pending'
    )
    expect(deriveServiceConfigApplyState({ ...base, operation: null })).toBe('pending')
  })

  it('reports changed or re-keyed sealed secrets as pending', () => {
    const base = {
      plannedPlain: planned,
      hasSettings: true,
      desiredPlain: planned,
      operation: operation('applied'),
    }
    const secrets = { fingerprint: 'f1', recipientKeyId: 'k1' }
    const same = sealedSecretsMarker(secrets)
    expect(
      deriveServiceConfigApplyState({ ...base, plannedSecrets: same, desiredSecrets: same })
    ).toBe('applied')
    expect(
      deriveServiceConfigApplyState({
        ...base,
        plannedSecrets: sealedSecretsMarker({ ...secrets, fingerprint: 'f2' }),
        desiredSecrets: same,
      })
    ).toBe('pending')
    expect(
      deriveServiceConfigApplyState({
        ...base,
        plannedSecrets: sealedSecretsMarker({ ...secrets, recipientKeyId: 'k2' }),
        desiredSecrets: same,
      })
    ).toBe('pending')
    expect(
      deriveServiceConfigApplyState({ ...base, plannedSecrets: null, desiredSecrets: same })
    ).toBe('pending')
  })
})

describe('sealedSecretsFile', () => {
  const context: SealedSecretContext = {
    projectRef: 'project-a',
    bindingId: 'binding-1',
    domain: 'auth',
    path: 'secrets.compose.yml',
  }
  const recipient = (seed: number) => {
    const publicKey = Buffer.alloc(32, seed)
    // Any 32 bytes are a valid X25519 public key.
    return { keyId: createHash('sha256').update(publicKey).digest('hex').slice(0, 32), publicKey }
  }
  const plaintext = 'services:\n  auth:\n    environment:\n      GOTRUE_SMTP_PASS: "hunter2"\n'
  const plan = (seed = 9, text = plaintext) => ({
    context,
    plaintext: text,
    fingerprint: sealedSecretFingerprint({ studioKey: 'studio-key', context, plaintext: text }),
    recipient: recipient(seed),
  })

  it('seals a group-readable file whose document carries only ciphertext', () => {
    const file = sealedSecretsFile(plan(), null)
    expect(file).toMatchObject({ path: 'secrets.compose.yml', content: '', mode: 0o640 })
    expect(file.sealed.envelope.recipientKeyId).toBe(recipient(9).keyId)
    expect(JSON.stringify(file)).not.toContain('hunter2')
    expect(file.sealed.fingerprint).not.toContain(
      createHash('sha256').update(plaintext).digest('hex')
    )
  })

  it('reuses the envelope only for the same secrets and recipient', () => {
    const first = sealedSecretsFile(plan(), null)
    expect(sealedSecretsFile(plan(), first.sealed).sealed.envelope).toBe(first.sealed.envelope)
    expect(sealedSecretsFile(plan(10), first.sealed).sealed.envelope).not.toEqual(
      first.sealed.envelope
    )
    const changed = sealedSecretsFile(
      plan(9, plaintext.replace('hunter2', 'hunter3')),
      first.sealed
    )
    expect(changed.sealed.envelope).not.toEqual(first.sealed.envelope)
    expect(changed.sealed.fingerprint).not.toBe(first.sealed.fingerprint)
  })
})

describe('plainFilesKey', () => {
  it('ignores file order and changes with content', () => {
    const a = { path: 'compose.yml', content: 'a' }
    const b = { path: 'secrets.compose.yml', content: 'b' }
    expect(plainFilesKey([a, b])).toBe(plainFilesKey([b, a]))
    expect(plainFilesKey([a, b])).not.toBe(plainFilesKey([a, { ...b, content: 'c' }]))
    expect(plainFilesKey([a])).not.toBe(plainFilesKey([a, b]))
  })
})

describe('kubernetesSecretsPlaintext', () => {
  it('is stable regardless of key order', () => {
    expect(kubernetesSecretsPlaintext({ B: '2', A: '1' })).toBe('{"A":"1","B":"2"}')
    expect(kubernetesSecretsPlaintext({})).toBe('{}')
  })
})
