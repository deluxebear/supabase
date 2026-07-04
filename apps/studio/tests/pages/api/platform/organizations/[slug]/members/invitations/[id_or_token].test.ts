import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acceptInvitationOrgWide,
  acceptInvitationScoped,
  deleteInvitationById,
  getInvitationByToken,
  getPendingInvitationById,
} from '@/lib/api/self-platform/invitations'
import { getOrganizationBySlug, getOrgMfaEnforced } from '@/lib/api/self-platform/organizations'
import { getProfileByGotrueId } from '@/lib/api/self-platform/profiles'
import { checkPermission, guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getOrgProjectIdsByRefs } from '@/lib/api/self-platform/roles'
import { handler } from '@/pages/api/platform/organizations/[slug]/members/invitations/[id_or_token]'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/organizations', () => ({
  getOrganizationBySlug: vi.fn(),
  getOrgMfaEnforced: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/profiles', () => ({ getProfileByGotrueId: vi.fn() }))
vi.mock('@/lib/api/self-platform/invitations', () => ({
  acceptInvitationOrgWide: vi.fn(),
  acceptInvitationScoped: vi.fn(),
  deleteInvitationById: vi.fn(),
  getInvitationByToken: vi.fn(),
  getPendingInvitationById: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/roles', () => ({ getOrgProjectIdsByRefs: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  checkPermission: vi.fn(),
  guardOrgRoute: vi.fn(),
}))

// aal2 = MFA satisfied; aal1 = not.
const claims = (over: Partial<JwtPayload> = {}) =>
  ({ sub: 'g-1', email: 'invitee@x.test', aal: 'aal2', ...over }) as JwtPayload

beforeEach(() => vi.clearAllMocks())

// ---- DELETE (revoke by id) ----
describe('DELETE (revoke)', () => {
  it('baseline guard → lookup → per-role checkPermission → delete', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })
    vi.mocked(getPendingInvitationById).mockResolvedValue({ id: 4, role_id: 3 })
    vi.mocked(checkPermission).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { slug: 'default', id_or_token: '4' },
    })
    await handler(req as never, res as never, claims())
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'write:Delete',
      resource: 'user_invites',
    })
    expect(vi.mocked(checkPermission).mock.calls[0][1]).toMatchObject({
      action: 'write:Delete',
      resource: 'user_invites',
      orgSlug: 'default',
      data: { resource: { role_id: 3 } },
    })
    expect(deleteInvitationById).toHaveBeenCalledWith(1, 4)
    expect(res._getStatusCode()).toBe(200)
  })

  it('404 when the pending invite is absent', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })
    vi.mocked(getPendingInvitationById).mockResolvedValue(null)
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { slug: 'default', id_or_token: '4' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Invitation not found' })
    expect(deleteInvitationById).not.toHaveBeenCalled()
  })

  it('403 when the per-role check denies (Admin revoking an Owner invite)', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })
    vi.mocked(getPendingInvitationById).mockResolvedValue({ id: 4, role_id: 1 })
    vi.mocked(checkPermission).mockResolvedValue(false)
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { slug: 'default', id_or_token: '4' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(403)
    expect(deleteInvitationById).not.toHaveBeenCalled()
  })

  it('400 for a non-numeric id', async () => {
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { slug: 'default', id_or_token: 'not-a-number' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(400)
    expect(guardOrgRoute).not.toHaveBeenCalled()
  })
})

// ---- GET (by-token) ----
describe('GET (by-token)', () => {
  it('unknown token → 200 token_does_not_exist, no org leak', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue(null)
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({ token_does_not_exist: true, organization_name: '' })
  })

  it('missing org → same token_does_not_exist (never reveals org existence)', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(null)
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'ghost', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({ token_does_not_exist: true, organization_name: '' })
    expect(getInvitationByToken).not.toHaveBeenCalled()
  })

  it('consumed token → 401 "Failed to retrieve organization invitation"', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue({
      id: 4,
      invited_email: 'invitee@x.test',
      role_id: 3,
      role_scoped_projects: null,
      expires_at: '2999-01-01T00:00:00Z',
      accepted_at: '2026-07-04T00:00:00Z',
    })
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData().message).toContain('Failed to retrieve organization')
  })

  it('enforce_mfa + aal1 → 403 with an "MFA required" message (before revealing email_match)', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue({
      id: 4,
      invited_email: 'invitee@x.test',
      role_id: 3,
      role_scoped_projects: null,
      expires_at: '2999-01-01T00:00:00Z',
      accepted_at: null,
    })
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims({ aal: 'aal1' }))
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData().message).toContain('MFA required')
  })

  it('valid pending → 200 with email_match and expired flags', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue({
      id: 4,
      invited_email: 'invitee@x.test',
      role_id: 3,
      role_scoped_projects: null,
      expires_at: '2999-01-01T00:00:00Z',
      accepted_at: null,
    })
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(false)
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims({ email: 'INVITEE@x.test' })) // case-insensitive
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({
      authorized_user: true,
      email_match: true,
      expired_token: false,
      invite_id: 4,
      organization_name: 'Default',
      sso_mismatch: false,
      token_does_not_exist: false,
    })
  })
})

// ---- POST (accept) ----
describe('POST (accept)', () => {
  const pending = {
    id: 4,
    invited_email: 'invitee@x.test',
    role_id: 3,
    role_scoped_projects: null,
    expires_at: '2999-01-01T00:00:00Z',
    accepted_at: null,
  }
  const okProfile = {
    id: 5,
    gotrue_id: 'g-1',
    username: 'x',
    primary_email: 'invitee@x.test',
    first_name: null,
    last_name: null,
  }

  it('org-wide accept consumes and grants', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue(pending)
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(false)
    vi.mocked(getProfileByGotrueId).mockResolvedValue(okProfile)
    vi.mocked(acceptInvitationOrgWide).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(acceptInvitationOrgWide).toHaveBeenCalledWith('tok', 1, 5)
    expect(res._getStatusCode()).toBe(201)
  })

  it('scoped accept re-validates refs then consumes+grants derived role', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue({
      ...pending,
      role_scoped_projects: ['proj-b'],
    })
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(false)
    vi.mocked(getProfileByGotrueId).mockResolvedValue(okProfile)
    vi.mocked(getOrgProjectIdsByRefs).mockResolvedValue(new Map([['proj-b', 42]]))
    vi.mocked(acceptInvitationScoped).mockResolvedValue(true)
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(acceptInvitationScoped).toHaveBeenCalledWith('tok', 1, 5, [42])
    expect(res._getStatusCode()).toBe(201)
  })

  it('email mismatch → 403 (fail-closed re-check, GET is advisory)', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue(pending)
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(false)
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims({ email: 'someone-else@x.test' }))
    expect(res._getStatusCode()).toBe(403)
    expect(acceptInvitationOrgWide).not.toHaveBeenCalled()
  })

  it('expired → 400', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue({
      ...pending,
      expires_at: '2000-01-01T00:00:00Z',
    })
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(false)
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData().message).toContain('expired')
  })

  it('consumed → 401 same message as GET', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue({
      ...pending,
      accepted_at: '2026-07-04T00:00:00Z',
    })
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(401)
  })

  it('missing token → 404', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue(null)
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(404)
  })

  it('claim race (accept fn returns false) → 401', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })
    vi.mocked(getInvitationByToken).mockResolvedValue(pending)
    vi.mocked(getOrgMfaEnforced).mockResolvedValue(false)
    vi.mocked(getProfileByGotrueId).mockResolvedValue(okProfile)
    vi.mocked(acceptInvitationOrgWide).mockResolvedValue(false) // consumed between check and claim
    const { req, res } = createMocks({
      method: 'POST',
      query: { slug: 'default', id_or_token: 'tok' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(401)
  })
})

describe('method routing', () => {
  it('405 for PUT', async () => {
    const { req, res } = createMocks({
      method: 'PUT',
      query: { slug: 'default', id_or_token: 'x' },
    })
    await handler(req as never, res as never, claims())
    expect(res._getStatusCode()).toBe(405)
  })
})
