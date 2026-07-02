import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import {
  createProfileWithDefaultMembership,
  getProfileByGotrueId,
} from '@/lib/api/self-platform/profiles'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/profiles', () => ({
  getProfileByGotrueId: vi.fn(),
  createProfileWithDefaultMembership: vi.fn(),
  toProfileResponse: (row: any) => ({ ...row, mapped: true }),
}))

const claims = { sub: '4c1e58f1-9d90-4f66-9b7e-000000000001', email: 'admin@internal.test' }
const row = { id: 7, gotrue_id: claims.sub, username: 'admin', primary_email: claims.email }

beforeEach(() => vi.clearAllMocks())

describe('GET /platform/profile (self-platform)', () => {
  it('returns 404 with the exact frontend trigger message when profile missing', async () => {
    vi.mocked(getProfileByGotrueId).mockResolvedValue(null)
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, claims as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: "User's profile not found" })
  })

  it('returns the mapped profile when found', async () => {
    vi.mocked(getProfileByGotrueId).mockResolvedValue(row as any)
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as any, res as any, claims as any)
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({ id: 7, mapped: true })
  })
})

describe('POST /platform/profile (self-platform)', () => {
  it('creates profile + default membership from claims', async () => {
    vi.mocked(createProfileWithDefaultMembership).mockResolvedValue(row as any)
    const { req, res } = createMocks({ method: 'POST' })
    await handler(req as any, res as any, claims as any)
    expect(createProfileWithDefaultMembership).toHaveBeenCalledWith({
      gotrueId: claims.sub,
      email: claims.email,
    })
    expect(res._getStatusCode()).toBe(201)
  })
})
