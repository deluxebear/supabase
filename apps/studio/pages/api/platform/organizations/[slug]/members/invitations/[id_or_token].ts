// [self-platform] Organization invitation item routes (M3.2). One file because
// Next.js gives {id} and {token} the same dynamic segment:
//   DELETE  -> revoke by numeric id (guarded, member-management surface)
//   GET     -> read by token (capability; NO membership guard — the invitee is
//              not a member; possession of the token is the capability)
//   POST    -> accept by token (capability; fail-closed re-check of everything
//              the GET showed, then an atomic claim)
// Info-hiding: by-token responses never distinguish "org missing" from "token
// missing" (both -> token_does_not_exist), and a token is looked up scoped to
// the slug's org so a cross-org token does not resolve.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
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
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type InvitationByTokenResponse = components['schemas']['InvitationByTokenResponse']

const CONSUMED_MESSAGE = 'Failed to retrieve organization invitation'
const MFA_JOIN_MESSAGE = 'MFA required to join this organization'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  switch (req.method) {
    case 'DELETE':
      return handleRevoke(req, res, claims)
    case 'GET':
      return handleGetByToken(req, res, claims)
    case 'POST':
      return handleAccept(req, res, claims)
    default:
      res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
      return res
        .status(405)
        .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}

function pathParams(req: NextApiRequest) {
  if (Array.isArray(req.query.slug) || Array.isArray(req.query.id_or_token)) return null
  return { slug: String(req.query.slug), idOrToken: String(req.query.id_or_token) }
}

async function handleRevoke(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const p = pathParams(req)
  if (!p) return res.status(400).json({ message: 'Invalid path parameter' })
  const id = Number(p.idOrToken)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid invitation id' })
  }

  // Baseline gate rejects Developer/Read-only/zero-role outright; the per-role
  // check below adds the owner-protection dimension (Admin can't revoke an
  // Owner invite), mirroring the UI canRevokeInvite gating.
  const org = await guardOrgRoute(res, claims, {
    slug: p.slug,
    action: PermissionAction.DELETE,
    resource: 'user_invites',
  })
  if (!org) return

  const invite = await getPendingInvitationById(org.orgId, id)
  if (!invite) {
    return res.status(404).json({ message: 'Invitation not found' })
  }
  const can = await checkPermission(claims, {
    action: PermissionAction.DELETE,
    resource: 'user_invites',
    orgSlug: org.orgSlug,
    data: { resource: { role_id: invite.role_id } },
  })
  if (!can) {
    return res.status(403).json({ message: 'Forbidden' })
  }
  await deleteInvitationById(org.orgId, id)
  return res.status(200).json({})
}

async function handleGetByToken(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const p = pathParams(req)
  if (!p) return res.status(400).json({ message: 'Invalid path parameter' })

  const notFound: InvitationByTokenResponse = {
    authorized_user: true,
    email_match: false,
    expired_token: false,
    organization_name: '',
    sso_mismatch: false,
    token_does_not_exist: true,
  }

  const org = await getOrganizationBySlug(p.slug)
  if (!org) return res.status(200).json(notFound) // never reveal org existence

  const invite = await getInvitationByToken(org.id, p.idOrToken)
  if (!invite) return res.status(200).json(notFound)

  if (invite.accepted_at !== null) {
    return res.status(401).json({ message: CONSUMED_MESSAGE })
  }
  if (await getOrgMfaEnforced(org.id)) {
    if (claims?.aal !== 'aal2') {
      return res.status(403).json({ message: MFA_JOIN_MESSAGE })
    }
  }
  const response: InvitationByTokenResponse = {
    authorized_user: true,
    email_match: (claims?.email ?? '').toLowerCase() === invite.invited_email.toLowerCase(),
    expired_token: new Date(invite.expires_at).getTime() < Date.now(),
    invite_id: invite.id,
    organization_name: org.name,
    sso_mismatch: false,
    token_does_not_exist: false,
  }
  return res.status(200).json(response)
}

async function handleAccept(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const p = pathParams(req)
  if (!p) return res.status(400).json({ message: 'Invalid path parameter' })

  const org = await getOrganizationBySlug(p.slug)
  if (!org) return res.status(404).json({ message: 'Invitation not found' })

  const invite = await getInvitationByToken(org.id, p.idOrToken)
  if (!invite) return res.status(404).json({ message: 'Invitation not found' })

  // Fail-closed re-check (the GET was advisory UI):
  if (invite.accepted_at !== null) {
    return res.status(401).json({ message: CONSUMED_MESSAGE })
  }
  if (await getOrgMfaEnforced(org.id)) {
    if (claims?.aal !== 'aal2') {
      return res.status(403).json({ message: MFA_JOIN_MESSAGE })
    }
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ message: 'Invitation has expired' })
  }
  if ((claims?.email ?? '').toLowerCase() !== invite.invited_email.toLowerCase()) {
    return res.status(403).json({ message: 'Invitation was issued for a different email' })
  }

  const profile = await getProfileByGotrueId(claims!.sub)
  if (!profile) {
    // First-login boot creates the profile before /join renders; defensive.
    return res.status(500).json({ message: 'Profile not provisioned' })
  }

  let claimed: boolean
  const scoped = invite.role_scoped_projects
  if (scoped === null || scoped.length === 0) {
    claimed = await acceptInvitationOrgWide(p.idOrToken, org.id, profile.id)
  } else {
    // Re-validate refs at accept (a project deleted since invite fails loud).
    // Set-dedup is REQUIRED: acceptInvitationScoped's link_projects insert has
    // no on-conflict, so duplicate ids would 500 (Task 2 review finding).
    const uniqueRefs = [...new Set(scoped)]
    const refMap = await getOrgProjectIdsByRefs(org.id, uniqueRefs)
    const missing = uniqueRefs.filter((r) => !refMap.has(r))
    if (missing.length > 0) {
      return res.status(400).json({ message: `Unknown project refs: ${missing.join(', ')}` })
    }
    claimed = await acceptInvitationScoped(
      p.idOrToken,
      org.id,
      profile.id,
      uniqueRefs.map((r) => refMap.get(r)!)
    )
  }

  if (!claimed) {
    // Consumed/expired in the window between the re-check and the atomic claim.
    return res.status(401).json({ message: CONSUMED_MESSAGE })
  }
  return res.status(201).json({})
}
