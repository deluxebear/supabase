// [self-platform] Seals secret material to one Fleet Agent's X25519 recipient
// key (supabase.fleet.sealed-secret.v1). The operation record, Fleet Control,
// and evidence then carry only ciphertext. Must stay byte-compatible with
// apps/backup-operator/internal/sealedsecret, which opens the envelope; both
// test suites check the same vector.
import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

export const SEALED_SECRET_SCHEMA = 'supabase.fleet.sealed-secret.v1'

const KEY_SIZE = 32
const NONCE_SIZE = 12
const MAX_PLAINTEXT = 1 << 20
// DER prefixes for raw X25519 keys (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export type SealedSecretEnvelope = {
  schema: typeof SEALED_SECRET_SCHEMA
  recipientKeyId: string
  ephemeralPublicKey: string
  nonce: string
  ciphertext: string
}

export type SealedSecretContext = {
  projectRef: string
  bindingId: string
  domain: string
  path: string
}

export function sealedSecretKeyId(recipientPublicKey: Buffer): string {
  return createHash('sha256').update(recipientPublicKey).digest('hex').slice(0, 32)
}

function additionalData(context: SealedSecretContext, keyId: string) {
  return Buffer.from(
    [
      SEALED_SECRET_SCHEMA,
      context.projectRef,
      context.bindingId,
      context.domain,
      context.path,
      keyId,
    ].join('\n')
  )
}

function validateContext(context: SealedSecretContext) {
  for (const value of Object.values(context)) {
    if (value === '' || /[\n\0]/.test(value)) throw new Error('Sealed secret context is invalid')
  }
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== KEY_SIZE) throw new Error('Recipient key must be 32 bytes')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function rawPublicKey(key: KeyObject): Buffer {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI_PREFIX.length)
}

/**
 * Seals `plaintext` to the recipient. `ephemeralPrivateKey` and `nonce` exist
 * only so tests can reproduce the shared vector; production callers omit them.
 */
export function sealSecret(input: {
  recipientPublicKey: Buffer
  context: SealedSecretContext
  plaintext: string
  ephemeralPrivateKey?: Buffer
  nonce?: Buffer
}): SealedSecretEnvelope {
  validateContext(input.context)
  const plaintext = Buffer.from(input.plaintext, 'utf8')
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT) {
    throw new Error('Sealed secret plaintext must be between 1 byte and 1 MiB')
  }
  const recipient = publicKeyFromRaw(input.recipientPublicKey)
  const ephemeral =
    input.ephemeralPrivateKey === undefined
      ? generateKeyPairSync('x25519').privateKey
      : createPrivateKey({
          key: Buffer.concat([PKCS8_PREFIX, input.ephemeralPrivateKey]),
          format: 'der',
          type: 'pkcs8',
        })
  const ephemeralPublic = rawPublicKey(createPublicKey(ephemeral))
  const shared = diffieHellman({ privateKey: ephemeral, publicKey: recipient })
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeralPublic, input.recipientPublicKey]),
      SEALED_SECRET_SCHEMA,
      KEY_SIZE
    )
  )
  const nonce = input.nonce ?? randomBytes(NONCE_SIZE)
  if (nonce.length !== NONCE_SIZE) throw new Error('Nonce must be 12 bytes')
  const recipientKeyId = sealedSecretKeyId(input.recipientPublicKey)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(additionalData(input.context, recipientKeyId))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return {
    schema: SEALED_SECRET_SCHEMA,
    recipientKeyId,
    ephemeralPublicKey: ephemeralPublic.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/** Matches sealedsecret.Digest: SHA-256 of the envelope JSON in field order. */
export function sealedSecretDigest(envelope: SealedSecretEnvelope): string {
  const ordered = {
    schema: envelope.schema,
    recipientKeyId: envelope.recipientKeyId,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}
