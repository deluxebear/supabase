// [self-platform] Minimal HS256 JWT signer for short-lived per-project keys
// (cloud's temporary api-key semantics). Signing only — no verification, no
// new dependency (jsonwebtoken/jose are not in this workspace).
import { createHmac } from 'node:crypto'

const b64url = (input: string) => Buffer.from(input).toString('base64url')

export function mintServiceJwt(secret: string, role: string, expiresInSeconds: number): string {
  if (!secret) throw new Error('jwt secret is not configured')
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({ role, iss: 'supabase', iat: now, exp: now + expiresInSeconds })
  )
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}
