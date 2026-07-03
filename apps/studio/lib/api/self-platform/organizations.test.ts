import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  getOrganizationBySlug,
  getOrgMfaEnforced,
  listOrganizations,
  listOrganizationsForProfile,
  setOrgMfaEnforced,
  toOrganizationResponse,
  toOrganizationSlugResponse,
} from './organizations'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const row = { id: 1, slug: 'default', name: 'Default Organization' }
const GOTRUE_ID = '11111111-2222-3333-4444-555555555555'

describe('toOrganizationResponse', () => {
  it('produces the OrganizationResponse contract with enterprise plan and is_owner=true when isOwner', () => {
    expect(toOrganizationResponse(row, true)).toMatchObject({
      id: 1,
      slug: 'default',
      name: 'Default Organization',
      is_owner: true,
      plan: { id: 'enterprise', name: 'Enterprise' },
      opt_in_tags: [],
      billing_email: null,
      restriction_status: null,
    })
  })

  it('sets is_owner=false when isOwner is false, every other field unchanged', () => {
    expect(toOrganizationResponse(row, false)).toMatchObject({
      id: 1,
      slug: 'default',
      name: 'Default Organization',
      is_owner: false,
      plan: { id: 'enterprise', name: 'Enterprise' },
      opt_in_tags: [],
      billing_email: null,
      restriction_status: null,
    })
  })
})

describe('toOrganizationSlugResponse', () => {
  it('includes has_oriole_project and drops list-only fields', () => {
    const res = toOrganizationSlugResponse(row)
    expect(res).toMatchObject({ slug: 'default', has_oriole_project: false })
    expect('is_owner' in res).toBe(false)
  })
})

describe('queries', () => {
  it('listOrganizations selects all rows', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })
    expect(await listOrganizations()).toEqual([row])
  })

  it('getOrganizationBySlug binds the slug parameter', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await getOrganizationBySlug('default')).toBeNull()
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual(['default'])
  })

  it('listOrganizationsForProfile parameterizes the gotrue id and joins membership + profiles', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })
    expect(await listOrganizationsForProfile(GOTRUE_ID)).toEqual([row])
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual([GOTRUE_ID])
    expect(call.query).toContain('platform.organization_members')
    expect(call.query).toContain('join platform.profiles')
  })
})

describe('org MFA enforcement flag (M3.1)', () => {
  beforeEach(() => {
    vi.mocked(executePlatformQuery).mockReset()
  })

  it('reads the flag parameterized; missing column degrades to false with a warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ enforce_mfa: true }],
      error: undefined,
    })
    expect(await getOrgMfaEnforced(1)).toBe(true)
    expect(vi.mocked(executePlatformQuery).mock.calls[0][0].parameters).toEqual([1])

    // 缺列（pre-05 库）→ false，不炸页，warn 一次
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('column "enforce_mfa" does not exist'),
    })
    expect(await getOrgMfaEnforced(1)).toBe(false)
    expect(await getOrgMfaEnforced(1)).toBe(false)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('05-mfa-enforcement.sql')

    warnSpy.mockRestore()
  })

  it('propagates non-missing-column read errors', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('connection refused'),
    })
    await expect(getOrgMfaEnforced(1)).rejects.toThrow('connection refused')
  })

  it('writes the flag parameterized and propagates errors (PATCH is honest)', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await setOrgMfaEnforced(1, true)
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual([1, true])
    expect(call.query).toContain('update platform.organizations')

    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('column "enforce_mfa" does not exist'),
    })
    await expect(setOrgMfaEnforced(1, true)).rejects.toThrow()
  })
})
