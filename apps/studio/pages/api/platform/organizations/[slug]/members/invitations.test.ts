import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './invitations'
import {
  getExistingMemberEmails,
  insertInvitation,
  listPendingInvitations,
} from '@/lib/api/self-platform/invitations'
import { sendInvitationEmail } from '@/lib/api/self-platform/invite-email'
import { getProfileByGotrueId } from '@/lib/api/self-platform/profiles'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getOrgProjectIdsByRefs, getRoleInOrg } from '@/lib/api/self-platform/roles'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/invitations', () => ({
  getExistingMemberEmails: vi.fn(),
  insertInvitation: vi.fn(),
  listPendingInvitations: vi.fn(),
  deleteInvitationById: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/roles', () => ({
  getRoleInOrg: vi.fn(),
  getOrgProjectIdsByRefs: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/profiles', () => ({ getProfileByGotrueId: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/invite-email', () => ({ sendInvitationEmail: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload
const okGuard = () => vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /members/invitations (real list)', () => {
  it('returns pending invitations wrapped in { invitations }', async () => {
    okGuard()
    vi.mocked(listPendingInvitations).mockResolvedValue([
      { id: 3, invited_at: '2026-07-04T00:00:00Z', invited_email: 'a@x.test', role_id: 3 },
    ])
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    // guard unchanged from M3.1 stub — READ organizations (any member)
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'read:Read',
      resource: 'organizations',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({
      invitations: [
        { id: 3, invited_at: '2026-07-04T00:00:00Z', invited_email: 'a@x.test', role_id: 3 },
      ],
    })
  })

  it('guard deny short-circuits, no list query', async () => {
    vi.mocked(guardOrgRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return null
    })
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-0'))
    expect(res._getStatusCode()).toBe(403)
    expect(listPendingInvitations).not.toHaveBeenCalled()
  })
})

describe('POST /members/invitations (create, batch)', () => {
  it('creates for each new email, sends mail, returns succeeded/failed', async () => {
    okGuard()
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 3, base_role_id: 3, name: 'Developer' })
    vi.mocked(getProfileByGotrueId).mockResolvedValue({
      id: 5,
      gotrue_id: 'g-1',
      username: 'admin',
      primary_email: 'admin@x.test',
      first_name: null,
      last_name: null,
    })
    vi.mocked(getExistingMemberEmails).mockResolvedValue(['member@x.test'])
    vi.mocked(insertInvitation).mockResolvedValue({ id: 9, token: 'tok' })
    vi.mocked(sendInvitationEmail).mockResolvedValue()
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { emails: ['New@x.test', 'member@x.test'], role_id: 3 },
    })
    await handler(req as never, res as never, claimsOf('g-1'))
    // guard carries role_id condition data (owner-protection)
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'write:Create',
      resource: 'user_invites',
      data: { resource: { role_id: 3 } },
    })
    expect(res._getStatusCode()).toBe(201)
    const body = res._getJSONData()
    expect(body.succeeded).toEqual(['new@x.test']) // lowercased, member excluded
    expect(body.failed).toEqual([
      { email: 'member@x.test', error: 'This user is already a member of the organization' },
    ])
    expect(sendInvitationEmail).toHaveBeenCalledWith({
      email: 'new@x.test',
      orgSlug: 'default',
      token: 'tok',
    })
  })

  it('deletes the row and fails the email when dispatch throws', async () => {
    okGuard()
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 3, base_role_id: 3, name: 'Developer' })
    vi.mocked(getProfileByGotrueId).mockResolvedValue({
      id: 5,
      gotrue_id: 'g-1',
      username: 'admin',
      primary_email: 'admin@x.test',
      first_name: null,
      last_name: null,
    })
    vi.mocked(getExistingMemberEmails).mockResolvedValue([])
    vi.mocked(insertInvitation).mockResolvedValue({ id: 9, token: 'tok' })
    vi.mocked(sendInvitationEmail).mockRejectedValue(new Error('smtp down'))
    const { deleteInvitationById } = await import('@/lib/api/self-platform/invitations')
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { emails: ['a@x.test'], role_id: 3 },
    })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(deleteInvitationById)).toHaveBeenCalledWith(1, 9)
    expect(res._getJSONData()).toEqual({
      succeeded: [],
      failed: [{ email: 'a@x.test', error: 'Failed to send invitation email' }],
    })
  })

  it('already-pending (insert null) → failed entry, no email', async () => {
    okGuard()
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 3, base_role_id: 3, name: 'Developer' })
    vi.mocked(getProfileByGotrueId).mockResolvedValue({
      id: 5,
      gotrue_id: 'g-1',
      username: 'admin',
      primary_email: 'admin@x.test',
      first_name: null,
      last_name: null,
    })
    vi.mocked(getExistingMemberEmails).mockResolvedValue([])
    vi.mocked(insertInvitation).mockResolvedValue(null)
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { emails: ['a@x.test'], role_id: 3 },
    })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(sendInvitationEmail).not.toHaveBeenCalled()
    expect(res._getJSONData().failed).toEqual([
      { email: 'a@x.test', error: 'This user has already been invited' },
    ])
  })

  it('400 when role_id is not a base org-scoped role', async () => {
    okGuard()
    vi.mocked(getRoleInOrg).mockResolvedValue({
      id: 5,
      base_role_id: 3,
      name: 'Developer_scoped_x',
    })
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { emails: ['a@x.test'], role_id: 5 },
    })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'role_id must be an org-scoped base role' })
    expect(insertInvitation).not.toHaveBeenCalled()
  })

  it('400 with the miss list when role_scoped_projects has a ghost ref', async () => {
    okGuard()
    vi.mocked(getRoleInOrg).mockResolvedValue({ id: 3, base_role_id: 3, name: 'Developer' })
    vi.mocked(getOrgProjectIdsByRefs).mockResolvedValue(new Map()) // nothing resolves
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { emails: ['a@x.test'], role_id: 3, role_scoped_projects: ['ghost', 'ghost'] },
    })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Unknown project refs: ghost' }) // Set-deduped
  })

  it('400 when neither emails nor email present', async () => {
    okGuard()
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default' },
      body: { role_id: 3 },
    })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(400)
  })

  it('405 for PUT', async () => {
    const { req, res } = createMocks({ method: 'PUT', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    expect(guardOrgRoute).not.toHaveBeenCalled()
  })
})
