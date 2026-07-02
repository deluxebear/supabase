import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { mintServiceJwt } from './mint-jwt'

function decodeSegment(seg: string) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
}

describe('mintServiceJwt', () => {
  it('mints a verifiable HS256 JWT with role/iss/iat/exp', () => {
    const token = mintServiceJwt('test-secret', 'service_role', 300)
    const [h, p, sig] = token.split('.')
    expect(decodeSegment(h)).toEqual({ alg: 'HS256', typ: 'JWT' })
    const payload = decodeSegment(p)
    expect(payload.role).toBe('service_role')
    expect(payload.iss).toBe('supabase')
    expect(payload.exp - payload.iat).toBe(300)
    const expected = createHmac('sha256', 'test-secret').update(`${h}.${p}`).digest('base64url')
    expect(sig).toBe(expected)
  })

  it('fails closed on an empty secret', () => {
    expect(() => mintServiceJwt('', 'service_role', 300)).toThrow('jwt secret is not configured')
  })
})
