import { describe, expect, it } from 'vitest'

import {
  SEALED_SECRET_SCHEMA,
  sealedSecretDigest,
  sealedSecretKeyId,
  sealSecret,
} from './sealed-secret'

const sequence = (start: number, length: number) =>
  Buffer.from(Array.from({ length }, (_, index) => start + index))

// Shared with apps/backup-operator/internal/sealedsecret/sealedsecret_test.go,
// which opens this exact envelope with the Agent's Go implementation.
const recipientPublicKey = Buffer.from('B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=', 'base64')
const context = {
  projectRef: 'project-a',
  bindingId: 'binding-1',
  domain: 'auth',
  path: 'secrets.compose.yml',
}
const plaintext = 'services:\n  auth:\n    environment:\n      GOTRUE_SMTP_PASS: "s3cr$$et"\n'
const vectorEnvelope = {
  schema: SEALED_SECRET_SCHEMA,
  recipientKeyId: 'aaa8fff703b50b2297f4f6e13508f724',
  ephemeralPublicKey: 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns=',
  nonce: 'QUJDREVGR0hJSktM',
  ciphertext:
    'S9fwcRcYjrqHRiukI8941HkkU7I7Cnpia9afS0ZuP48RhZ97/kUdm2vgXy0PTo45UedIBkGNhh6wEMq19gTg7J7xfq6hqSlaVTHW0ragc1Pok7wFXYM=',
}

describe('sealSecret', () => {
  it('reproduces the envelope the Go Agent opens', () => {
    const envelope = sealSecret({
      recipientPublicKey,
      context,
      plaintext,
      ephemeralPrivateKey: sequence(0x21, 32),
      nonce: sequence(0x41, 12),
    })
    expect(envelope).toEqual(vectorEnvelope)
    expect(sealedSecretDigest(envelope)).toBe(
      'ed9936cf9f2eb0d20feab8914d4e6c50bb5a6198029235151dfef0699eaa7e5f'
    )
    expect(sealedSecretKeyId(recipientPublicKey)).toBe(vectorEnvelope.recipientKeyId)
  })

  it('uses a fresh ephemeral key and nonce by default', () => {
    const first = sealSecret({ recipientPublicKey, context, plaintext })
    const second = sealSecret({ recipientPublicKey, context, plaintext })
    expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toContain('s3cr')
  })

  it('rejects invalid keys, contexts, and plaintext', () => {
    expect(() => sealSecret({ recipientPublicKey: sequence(1, 31), context, plaintext })).toThrow()
    expect(() =>
      sealSecret({ recipientPublicKey, context: { ...context, domain: 'a\nb' }, plaintext })
    ).toThrow()
    expect(() => sealSecret({ recipientPublicKey, context, plaintext: '' })).toThrow()
  })
})
