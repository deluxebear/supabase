import { describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  createProfileWithDefaultMembership,
  getProfileByGotrueId,
  toProfileResponse,
} from './profiles'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const row = {
  id: 7,
  gotrue_id: '4c1e58f1-9d90-4f66-9b7e-000000000001',
  username: 'admin',
  primary_email: 'admin@internal.test',
  first_name: null,
  last_name: null,
}

describe('toProfileResponse', () => {
  it('maps a platform.profiles row onto the ProfileResponse contract', () => {
    const res = toProfileResponse(row)
    expect(res).toMatchObject({
      id: 7,
      gotrue_id: row.gotrue_id,
      username: 'admin',
      primary_email: 'admin@internal.test',
      first_name: null,
      last_name: null,
      mobile: null,
      is_alpha_user: false,
      is_sso_user: false,
      disabled_features: [],
    })
    expect(typeof res.auth0_id).toBe('string')
  })
})

describe('getProfileByGotrueId', () => {
  it('returns null when no row', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await getProfileByGotrueId(row.gotrue_id)).toBeNull()
  })

  it('passes gotrue_id as a bind parameter', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })
    await getProfileByGotrueId(row.gotrue_id)
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual([row.gotrue_id])
    expect(call.query).not.toContain(row.gotrue_id)
  })
})

describe('createProfileWithDefaultMembership', () => {
  it('derives username from the email local part', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ ...row, org_exists: true }],
      error: undefined,
    })
    await createProfileWithDefaultMembership({
      gotrueId: row.gotrue_id,
      email: 'admin@internal.test',
    })
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual([row.gotrue_id, 'admin', 'admin@internal.test'])
  })

  it('throws when the query errors', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('db down'),
    })
    await expect(
      createProfileWithDefaultMembership({ gotrueId: row.gotrue_id, email: 'a@b.c' })
    ).rejects.toThrow('db down')
  })

  // I1 (refix): the membership insert is a `where slug = 'default'` lookup —
  // if the seed org is missing, the CTE chain still succeeds and returns the
  // profile row, silently leaving the user org-less. org_exists is derived
  // from a `target_org` CTE (a plain SELECT, visible in the same snapshot as
  // the membership insert) rather than reading back
  // platform.organization_members in the same statement — that read can
  // never observe a row inserted earlier in the same statement/snapshot, so
  // it was always false and threw on every fresh profile creation. A false
  // org_exists must still throw instead of returning a profile with no org.
  it('throws when the default org does not exist', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ ...row, org_exists: false }],
      error: undefined,
    })
    await expect(
      createProfileWithDefaultMembership({ gotrueId: row.gotrue_id, email: 'admin@internal.test' })
    ).rejects.toThrow(/default.*organization/i)
  })

  it('returns the profile (without the org_exists flag) when the default org exists', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ ...row, org_exists: true }],
      error: undefined,
    })
    const result = await createProfileWithDefaultMembership({
      gotrueId: row.gotrue_id,
      email: 'admin@internal.test',
    })
    expect(result).toEqual(row)
    expect(result).not.toHaveProperty('org_exists')
  })
})
