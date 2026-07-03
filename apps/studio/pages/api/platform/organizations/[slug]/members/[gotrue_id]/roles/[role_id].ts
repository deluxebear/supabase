// [self-platform] Member-role update/unassign (M3.1). PUT replaces a DERIVED
// role's project set (the contract's `name` field is accepted for
// compatibility but not persisted — derived role names are server-generated
// and internal). DELETE unassigns and GCs an orphaned derived role.
// Owner-protection boundary (spec §7.4, recorded semantics): the deny matrix
// keys on role_id == 1, and this route evaluates the PATH role id — matching
// the UI's rolesRemovable evaluation exactly. An Administrator therefore
// cannot revoke an org-wide Owner (id 1) but CAN revoke a derived
// Owner-based role (id != 1), same as the UI shows. The last-Owner guard is
// server-side lockout protection on top.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getMemberInOrg } from '@/lib/api/self-platform/members'
import { guardOrgRoute, type OrgRouteContext } from '@/lib/api/self-platform/rbac/enforce'
import {
  countOtherOrgScopedOwnerHolders,
  getOrgProjectIdsByRefs,
  getRoleInOrg,
  replaceRoleProjects,
  unassignRoleWithGc,
} from '@/lib/api/self-platform/roles'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type UpdateMemberRoleBody = components['schemas']['UpdateMemberRoleBody']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', ['PUT', 'DELETE'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (
    Array.isArray(req.query.slug) ||
    Array.isArray(req.query.gotrue_id) ||
    Array.isArray(req.query.role_id)
  ) {
    return res.status(400).json({ message: 'Invalid path parameter' })
  }
  const roleId = Number(req.query.role_id)
  if (!Number.isInteger(roleId)) {
    return res.status(400).json({ message: 'Invalid role_id parameter' })
  }
  const slug = String(req.query.slug)
  const targetGotrueId = String(req.query.gotrue_id)

  const org = await guardOrgRoute(res, claims, {
    slug,
    action: req.method === 'PUT' ? PermissionAction.CREATE : PermissionAction.DELETE,
    resource: 'auth.subject_roles',
    data: { resource: { role_id: roleId } },
  })
  if (!org) return

  if (req.method === 'PUT') return handlePut(req, res, org, targetGotrueId, roleId)
  return handleDelete(res, org, targetGotrueId, roleId)
}

async function handlePut(
  req: NextApiRequest,
  res: NextApiResponse,
  org: OrgRouteContext,
  targetGotrueId: string,
  roleId: number
) {
  const body = (req.body ?? {}) as Partial<UpdateMemberRoleBody>
  const scoped = body.role_scoped_projects
  if (!Array.isArray(scoped) || scoped.some((ref) => typeof ref !== 'string')) {
    return res.status(400).json({ message: 'Invalid role_scoped_projects' })
  }
  // HARD (spec constraint 2).
  if (scoped.length === 0) {
    return res
      .status(400)
      .json({ message: 'role_scoped_projects must be a non-empty list of project refs' })
  }

  // Role-type validation runs BEFORE the membership check: an org-scoped
  // base role targeted via PUT must 400 regardless of whether the path
  // member happens to hold it (matches the UI, which never offers PUT on a
  // base role in the first place).
  const target = await getMemberInOrg(org.orgId, targetGotrueId)
  if (!target) {
    return res.status(404).json({ message: 'Member role not found' })
  }
  const role = await getRoleInOrg(org.orgId, roleId)
  if (!role) {
    return res.status(404).json({ message: 'Member role not found' })
  }
  if (role.base_role_id === role.id) {
    return res.status(400).json({ message: 'Only project-scoped roles can be updated' })
  }
  if (!target.role_ids.includes(roleId)) {
    return res.status(404).json({ message: 'Member role not found' })
  }

  const refMap = await getOrgProjectIdsByRefs(org.orgId, scoped)
  const missing = scoped.filter((ref) => !refMap.has(ref))
  if (missing.length > 0) {
    return res.status(400).json({ message: `Unknown project refs: ${missing.join(', ')}` })
  }
  await replaceRoleProjects(
    roleId,
    scoped.map((ref) => refMap.get(ref)!)
  )
  return res.status(200).json({})
}

async function handleDelete(
  res: NextApiResponse,
  org: OrgRouteContext,
  targetGotrueId: string,
  roleId: number
) {
  const target = await getMemberInOrg(org.orgId, targetGotrueId)
  if (!target || !target.role_ids.includes(roleId)) {
    return res.status(404).json({ message: 'Member role not found' })
  }
  const role = await getRoleInOrg(org.orgId, roleId)
  if (!role) {
    return res.status(404).json({ message: 'Member role not found' })
  }
  // Server-side lockout protection: removing the last org-scoped Owner would
  // orphan the organization.
  if (role.base_role_id === role.id && role.name === 'Owner') {
    const others = await countOtherOrgScopedOwnerHolders(org.orgId, target.profile_id)
    if (others === 0) {
      return res.status(400).json({ message: 'Cannot remove the last Owner of the organization' })
    }
  }
  await unassignRoleWithGc(target.profile_id, roleId)
  return res.status(200).json({})
}
