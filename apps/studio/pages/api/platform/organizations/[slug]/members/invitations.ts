// [self-platform] Organization invitations collection (M3.2).
// GET: list PENDING invitations (accepted_at is null) — feeds the members
//   Promise.all (organization-members-query.ts remaps them to pseudo-members),
//   so the guard stays READ organizations (any member), matching GET members.
// POST: batch-create. One base role_id for the whole batch; the guard carries
//   { resource: { role_id } } so the matrix owner-protection deny fires for
//   Administrators inviting an Owner. Per email (all-or-nothing): reject
//   already-member / already-pending / ghost-ref, else insert the row and send
//   the GoTrue-mailed invite; a send failure deletes the row (invariant: a
//   pending row means an email went out).
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  deleteInvitationById,
  getExistingMemberEmails,
  insertInvitation,
  listPendingInvitations,
} from '@/lib/api/self-platform/invitations'
import { sendInvitationEmail } from '@/lib/api/self-platform/invite-email'
import { getProfileByGotrueId } from '@/lib/api/self-platform/profiles'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getOrgProjectIdsByRefs, getRoleInOrg } from '@/lib/api/self-platform/roles'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type InvitationResponse = components['schemas']['InvitationResponse']
type CreateInvitationBody = components['schemas']['CreateInvitationBody']
type CreateInvitationResponse = components['schemas']['CreateInvitationResponse']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  switch (req.method) {
    case 'GET':
      return handleGet(req, res, claims)
    case 'POST':
      return handlePost(req, res, claims)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      return res
        .status(405)
        .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ message: 'Invalid slug parameter' })
  }
  const org = await guardOrgRoute(res, claims, {
    slug: String(req.query.slug),
    action: PermissionAction.READ,
    resource: 'organizations',
  })
  if (!org) return

  const rows = await listPendingInvitations(org.orgId)
  const response: InvitationResponse = {
    invitations: rows.map((r) => ({
      id: r.id,
      invited_at: r.invited_at,
      invited_email: r.invited_email,
      role_id: r.role_id,
    })),
  }
  return res.status(200).json(response)
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ message: 'Invalid slug parameter' })
  }
  const slug = String(req.query.slug)
  const body = (req.body ?? {}) as Partial<CreateInvitationBody>

  // Normalize emails: emails[] wins, fall back to the deprecated single email.
  const rawEmails =
    Array.isArray(body.emails) && body.emails.length > 0
      ? body.emails
      : typeof body.email === 'string'
        ? [body.email]
        : []
  if (rawEmails.length === 0 || rawEmails.some((e) => typeof e !== 'string')) {
    return res.status(400).json({ message: 'emails must be a non-empty list' })
  }
  const emails = [...new Set(rawEmails.map((e) => e.toLowerCase()))]

  const roleId = body.role_id
  if (typeof roleId !== 'number' || !Number.isInteger(roleId)) {
    return res.status(400).json({ message: 'Invalid role_id' })
  }

  // role_scoped_projects: request-level validation (400s the whole request,
  // like PATCH member V2 — refs are not per-email).
  let projectRefs: string[] | null = null
  const scoped = body.role_scoped_projects
  if (scoped !== undefined) {
    if (!Array.isArray(scoped) || scoped.some((r) => typeof r !== 'string')) {
      return res.status(400).json({ message: 'Invalid role_scoped_projects' })
    }
    if (scoped.length === 0) {
      return res
        .status(400)
        .json({ message: 'role_scoped_projects must be a non-empty list of project refs' })
    }
    projectRefs = [...new Set(scoped)]
  }

  const org = await guardOrgRoute(res, claims, {
    slug,
    action: PermissionAction.CREATE,
    resource: 'user_invites',
    data: { resource: { role_id: roleId } },
  })
  if (!org) return

  // role must be a base org-scoped role of this org (laundering guard).
  const role = await getRoleInOrg(org.orgId, roleId)
  if (!role || role.base_role_id !== role.id) {
    return res.status(400).json({ message: 'role_id must be an org-scoped base role' })
  }

  // Resolve refs -> ids once for the whole batch.
  if (projectRefs !== null) {
    const refMap = await getOrgProjectIdsByRefs(org.orgId, projectRefs)
    const missing = projectRefs.filter((r) => !refMap.has(r))
    if (missing.length > 0) {
      return res.status(400).json({ message: `Unknown project refs: ${missing.join(', ')}` })
    }
  }

  const inviter = await getProfileByGotrueId(claims!.sub)
  if (!inviter) {
    // The guard proved membership, so a profile must exist; defensive.
    return res.status(500).json({ message: 'Inviter profile not found' })
  }
  const requireSso = body.require_sso === true

  const existingMembers = new Set(await getExistingMemberEmails(org.orgId, emails))

  const succeeded: string[] = []
  const failed: { email: string; error: string }[] = []
  for (const email of emails) {
    if (existingMembers.has(email)) {
      failed.push({ email, error: 'This user is already a member of the organization' })
      continue
    }
    const inserted = await insertInvitation({
      orgId: org.orgId,
      invitedEmail: email,
      roleId,
      roleScopedProjects: projectRefs,
      requireSso,
      invitedById: inviter.id,
    })
    if (!inserted) {
      failed.push({ email, error: 'This user has already been invited' })
      continue
    }
    try {
      await sendInvitationEmail({ email, orgSlug: slug, token: inserted.token })
    } catch {
      // Invariant: a pending row means an email went out. Roll back the row.
      await deleteInvitationById(org.orgId, inserted.id)
      failed.push({ email, error: 'Failed to send invitation email' })
      continue
    }
    succeeded.push(email)
  }

  const response: CreateInvitationResponse = { succeeded, failed }
  return res.status(201).json(response)
}
