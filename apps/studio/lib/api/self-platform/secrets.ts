// [self-platform] At-rest AES encryption for platform.projects secret columns.
// Uses PLATFORM_ENCRYPTION_KEY — distinct from PG_META_CRYPTO_KEY (which is the
// Studio<->pg-meta transport key). No weak default: missing key fails closed.
import crypto from 'crypto-js'

export const PLATFORM_ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY || ''

function requireKey(): string {
  if (!PLATFORM_ENCRYPTION_KEY) {
    throw new Error('PLATFORM_ENCRYPTION_KEY is not set')
  }
  return PLATFORM_ENCRYPTION_KEY
}

export function encryptSecret(plaintext: string): string {
  return crypto.AES.encrypt(plaintext, requireKey()).toString()
}

export function decryptSecret(ciphertext: string): string {
  const out = crypto.AES.decrypt(ciphertext, requireKey()).toString(crypto.enc.Utf8)
  if (!out) {
    throw new Error('failed to decrypt platform secret')
  }
  return out
}
