import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acceptInvitationOrgWide,
  acceptInvitationScoped,
  deleteInvitationById,
  getExistingMemberEmails,
  getInvitationByToken,
  getPendingInvitationById,
  insertInvitation,
  listPendingInvitations,
} from './invitations'

const executePlatformQuery = vi.hoisted(() => vi.fn())
vi.mock('./db', () => ({ executePlatformQuery }))

beforeEach(() => executePlatformQuery.mockReset())

describe('insertInvitation', () => {
  it('inserts with 24h default expiry (no explicit expires_at) and returns id+token', async () => {
    executePlatformQuery.mockResolvedValue({
      data: [{ id: 7, token: 'tok-uuid' }],
      error: undefined,
    })
    const out = await insertInvitation({
      orgId: 1,
      invitedEmail: 'a@x.test',
      roleId: 3,
      roleScopedProjects: null,
      requireSso: false,
      invitedById: 5,
    })
    const call = executePlatformQuery.mock.calls[0][0]
    // Expiry is the column default — the insert must NOT set expires_at, so the
    // 24h/UI-isInviteExpired contract lives in ONE place (the migration).
    expect(call.query).not.toContain('expires_at')
    expect(call.query).toContain('returning id, token')
    // partial-unique conflict target matches the index predicate
    expect(call.query).toContain(
      'on conflict (organization_id, invited_email) where accepted_at is null do nothing'
    )
    expect(call.parameters).toEqual([1, 'a@x.test', 3, null, false, 5])
    expect(out).toEqual({ id: 7, token: 'tok-uuid' })
  })

  it('returns null on partial-unique conflict (no returning row)', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    const out = await insertInvitation({
      orgId: 1,
      invitedEmail: 'a@x.test',
      roleId: 3,
      roleScopedProjects: null,
      requireSso: false,
      invitedById: 5,
    })
    expect(out).toBeNull()
  })

  it('passes role_scoped_projects as a text[] parameter when present', async () => {
    executePlatformQuery.mockResolvedValue({ data: [{ id: 8, token: 't' }], error: undefined })
    await insertInvitation({
      orgId: 1,
      invitedEmail: 'a@x.test',
      roleId: 3,
      roleScopedProjects: ['proj-b'],
      requireSso: true,
      invitedById: 5,
    })
    expect(executePlatformQuery.mock.calls[0][0].parameters).toEqual([
      1,
      'a@x.test',
      3,
      ['proj-b'],
      true,
      5,
    ])
  })
})

describe('listPendingInvitations', () => {
  it('filters accepted_at is null and selects the contract columns', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    await listPendingInvitations(1)
    const call = executePlatformQuery.mock.calls[0][0]
    expect(call.query).toContain('accepted_at is null')
    expect(call.query).toContain('invited_email')
    expect(call.parameters).toEqual([1])
  })
})

describe('getPendingInvitationById', () => {
  it('scopes to org + id + accepted_at is null, returns null when absent', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    const out = await getPendingInvitationById(1, 99)
    expect(executePlatformQuery.mock.calls[0][0].query).toContain('accepted_at is null')
    expect(executePlatformQuery.mock.calls[0][0].parameters).toEqual([1, 99])
    expect(out).toBeNull()
  })
})

describe('getInvitationByToken', () => {
  it('scopes lookup to (org, token) so a cross-org token does not resolve', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    await getInvitationByToken(1, 'tok')
    const call = executePlatformQuery.mock.calls[0][0]
    expect(call.query).toContain('organization_id = $1')
    // token::text (not token = $2): a malformed non-uuid token must yield zero
    // rows, not a uuid-parse 500 (E2E-discovered; info-hiding for garbage probes).
    expect(call.query).toContain('token::text = $2')
    expect(call.query).not.toContain('and token = $2')
    expect(call.parameters).toEqual([1, 'tok'])
  })
})

describe('getExistingMemberEmails', () => {
  it('lowercases the haystack and matches any($2)', async () => {
    executePlatformQuery.mockResolvedValue({ data: [{ email: 'a@x.test' }], error: undefined })
    const out = await getExistingMemberEmails(1, ['A@X.test'])
    const call = executePlatformQuery.mock.calls[0][0]
    expect(call.query).toContain('lower(pr.primary_email) = any($2)')
    expect(call.parameters).toEqual([1, ['a@x.test']])
    expect(out).toEqual(['a@x.test'])
  })
})

describe('acceptInvitationOrgWide', () => {
  it('claim gates on pending+unexpired; member_roles anchored on organization_members; returns claimed', async () => {
    executePlatformQuery.mockResolvedValue({ data: [{ claimed_count: 1 }], error: undefined })
    const out = await acceptInvitationOrgWide('tok', 1, 5)
    const q = executePlatformQuery.mock.calls[0][0].query
    expect(q).toContain('accepted_at is null and expires_at > now()') // claim gate
    expect(q).toContain('token::text = $1') // malformed token -> zero rows, not a uuid-parse 500
    expect(q).toContain('from platform.organization_members om') // membership anchor
    expect(q).toContain('select count(*)::int as claimed_count from claimed') // claim-driven result
    expect(executePlatformQuery.mock.calls[0][0].parameters).toEqual(['tok', 1, 5])
    expect(out).toBe(true)
  })

  it('returns false when the claim consumed nothing', async () => {
    executePlatformQuery.mockResolvedValue({ data: [{ claimed_count: 0 }], error: undefined })
    expect(await acceptInvitationOrgWide('tok', 1, 5)).toBe(false)
  })
})

describe('acceptInvitationScoped', () => {
  it('creates a _scoped_ derived role from the invitation role, links projects, anchored, returns claimed', async () => {
    executePlatformQuery.mockResolvedValue({ data: [{ claimed_count: 1 }], error: undefined })
    const out = await acceptInvitationScoped('tok', 1, 5, [42])
    const q = executePlatformQuery.mock.calls[0][0].query
    expect(q).toContain('token::text = $1') // malformed token -> zero rows, not a uuid-parse 500
    expect(q).toContain("'_scoped_'") // derived name convention
    expect(q).toContain('platform.role_projects') // project links
    expect(q).toContain('from platform.organization_members om') // membership anchor
    expect(q).toContain('select count(*)::int as claimed_count from claimed')
    expect(executePlatformQuery.mock.calls[0][0].parameters).toEqual(['tok', 1, 5, [42]])
    expect(out).toBe(true)
  })

  it('HARD (spec §5.3, 永不落库): rejects empty projectIds without querying', async () => {
    await expect(acceptInvitationScoped('tok', 1, 5, [])).rejects.toThrow('non-empty projectIds')
    expect(executePlatformQuery).not.toHaveBeenCalled()
  })

  it('returns false when the claim consumed nothing', async () => {
    executePlatformQuery.mockResolvedValue({ data: [{ claimed_count: 0 }], error: undefined })
    expect(await acceptInvitationScoped('tok', 1, 5, [42])).toBe(false)
  })
})

describe('error propagation', () => {
  it('insertInvitation rethrows a query error', async () => {
    executePlatformQuery.mockResolvedValue({ data: undefined, error: new Error('boom') })
    await expect(
      insertInvitation({
        orgId: 1,
        invitedEmail: 'a@x.test',
        roleId: 3,
        roleScopedProjects: null,
        requireSso: false,
        invitedById: 5,
      })
    ).rejects.toThrow('boom')
  })
})

describe('deleteInvitationById', () => {
  it('deletes by (org,id)', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    await deleteInvitationById(1, 7)
    const call = executePlatformQuery.mock.calls[0][0]
    expect(call.query).toContain('delete from platform.invitations')
    expect(call.parameters).toEqual([1, 7])
  })
})
