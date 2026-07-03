// [self-platform] Member role assignment, V2 semantics only (M3.1).
// PATCH assigns a role: without role_scoped_projects -> org-wide base-role
// link; with role_scoped_projects -> IMPLICIT derived-role creation (cloud
// parity — no standalone create-role endpoint). The guard carries
// { resource: { role_id } } so the matrix owner-protection deny
// (DENY_OWNER_ROLE_GRANTS) actually fires for Administrators — this covers
// both granting org-wide Owner AND creating a derived Owner (the body
// role_id is always the base id). Version header (string '2' from the
// frontend) is accepted in any form and not branched on.
// DELETE removes a member: a baseline guard (no condition data) rejects
// non-admin callers outright, then a per-held-role checkPermission call
// (each carrying { resource: { role_id } }) mirrors the UI's every-role
// removable semantics (MemberActions.tsx canRemoveMember) — ANY held role
// failing the check 403s the whole removal. A zero-role target passes on
// the baseline alone. Before removal, a last-Owner lockout check blocks
// orphaning the org. removeMemberWithGc then deletes the membership and
// garbage-collects any now-unreferenced derived roles (Task 7).
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getMemberInOrg } from '@/lib/api/self-platform/members'
import { checkPermission, guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  assignRoleToMember,
  countOtherOrgScopedOwnerHolders,
  createDerivedRoleWithAssignment,
  getOrgProjectIdsByRefs,
  getRoleInOrg,
  removeMemberWithGc,
} from '@/lib/api/self-platform/roles'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type AssignMemberRoleBodyV2 = components['schemas']['AssignMemberRoleBodyV2']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  switch (req.method) {
    case 'PATCH':
      return handlePatch(req, res, claims)
    case 'DELETE':
      return handleDelete(req, res, claims)
    default:
      res.setHeader('Allow', ['DELETE', 'PATCH'])
      return res
        .status(405)
        .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (Array.isArray(req.query.slug) || Array.isArray(req.query.gotrue_id)) {
    return res.status(400).json({ message: 'Invalid path parameter' })
  }
  const slug = String(req.query.slug)
  const targetGotrueId = String(req.query.gotrue_id)

  // Body validation FIRST: the guard's condition data needs role_id, so a
  // malformed body 400s before org resolution (recorded order deviation —
  // spec §7.2 note).
  const body = (req.body ?? {}) as Partial<AssignMemberRoleBodyV2>
  const roleId = body.role_id
  if (typeof roleId !== 'number' || !Number.isInteger(roleId)) {
    return res.status(400).json({ message: 'Invalid role_id' })
  }
  const scoped = body.role_scoped_projects
  if (
    scoped !== undefined &&
    (!Array.isArray(scoped) || scoped.some((ref) => typeof ref !== 'string'))
  ) {
    return res.status(400).json({ message: 'Invalid role_scoped_projects' })
  }
  // HARD (spec constraint 2): present-but-empty never reaches the data layer.
  if (scoped !== undefined && scoped.length === 0) {
    return res
      .status(400)
      .json({ message: 'role_scoped_projects must be a non-empty list of project refs' })
  }

  const org = await guardOrgRoute(res, claims, {
    slug,
    action: PermissionAction.CREATE,
    resource: 'auth.subject_roles',
    data: { resource: { role_id: roleId } },
  })
  if (!org) return

  const target = await getMemberInOrg(org.orgId, targetGotrueId)
  if (!target) {
    return res.status(404).json({ message: 'Member not found' })
  }

  const role = await getRoleInOrg(org.orgId, roleId)
  if (!role || role.base_role_id !== role.id) {
    // The frontend always sends base role ids (derived ids are created, never
    // sent); a derived or foreign id here is a client bug.
    return res.status(400).json({ message: 'role_id must be an org-scoped base role' })
  }

  if (scoped === undefined) {
    await assignRoleToMember(target.profile_id, roleId)
  } else {
    const refMap = await getOrgProjectIdsByRefs(org.orgId, scoped)
    const missing = scoped.filter((ref) => !refMap.has(ref))
    if (missing.length > 0) {
      return res.status(400).json({ message: `Unknown project refs: ${missing.join(', ')}` })
    }
    await createDerivedRoleWithAssignment({
      orgId: org.orgId,
      baseRoleId: roleId,
      profileId: target.profile_id,
      projectIds: scoped.map((ref) => refMap.get(ref)!),
    })
  }
  return res.status(200).json({})
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (Array.isArray(req.query.slug) || Array.isArray(req.query.gotrue_id)) {
    return res.status(400).json({ message: 'Invalid path parameter' })
  }
  const slug = String(req.query.slug)
  const targetGotrueId = String(req.query.gotrue_id)

  // Baseline gate first (rejects Developer/Read-only/zero-role callers
  // outright); the per-role condition checks below add the owner-protection
  // dimension, mirroring the UI's `every`-role removable semantics
  // (MemberActions.tsx canRemoveMember).
  const org = await guardOrgRoute(res, claims, {
    slug,
    action: PermissionAction.DELETE,
    resource: 'auth.subject_roles',
  })
  if (!org) return

  const target = await getMemberInOrg(org.orgId, targetGotrueId)
  if (!target) {
    return res.status(404).json({ message: 'Member not found' })
  }

  for (const heldRoleId of target.role_ids) {
    const can = await checkPermission(claims, {
      action: PermissionAction.DELETE,
      resource: 'auth.subject_roles',
      orgSlug: org.orgSlug,
      data: { resource: { role_id: heldRoleId } },
    })
    if (!can) {
      return res.status(403).json({ message: 'Forbidden' })
    }
  }

  // Lockout protection: if the target holds an org-scoped Owner role and no
  // OTHER profile does, removal would orphan the org.
  for (const heldRoleId of target.role_ids) {
    const role = await getRoleInOrg(org.orgId, heldRoleId)
    if (role && role.base_role_id === role.id && role.name === 'Owner') {
      const others = await countOtherOrgScopedOwnerHolders(org.orgId, target.profile_id)
      if (others === 0) {
        return res.status(400).json({ message: 'Cannot remove the last Owner of the organization' })
      }
    }
  }

  await removeMemberWithGc(org.orgId, target.profile_id)
  return res.status(200).json({})
}
