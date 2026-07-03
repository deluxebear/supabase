// [self-platform] Server-side RBAC enforcement (spec §7.2): platform GoTrue
// session (claims.sub) -> member roles -> matrix expansion -> the SAME
// evaluator the client uses. Fail closed: missing claims / zero roles /
// unknown role -> false. The subject is ALWAYS the dashboard session —
// never possession of a project's data-plane credential (spec §3.1,
// shared-stack JWT boundary).
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiResponse } from 'next'

import { getMemberContext, type MemberContext } from '../members'
import { listOrganizationsForProfile } from '../organizations'
import { resolveProjectConnection } from '../resolve-connection'
import { expandPermissions } from './expand'
import { doPermissionsCheck } from '@/lib/permissions-check'

export type PermissionCheckInput = {
  action: string
  resource: string
  projectRef?: string
  /** [self-platform] M3.1: org-slug-scoped routes evaluate against the PATH
   * org, not the member's first-org default (single-org assumption). */
  orgSlug?: string
  data?: object
}

export type PermissionCheckResult = { can: boolean; ctx: MemberContext | null }

export async function checkPermissionWithContext(
  claims: JwtPayload | undefined,
  input: PermissionCheckInput
): Promise<PermissionCheckResult> {
  const gotrueId = claims?.sub
  if (!gotrueId) return { can: false, ctx: null }
  const ctx = await getMemberContext(gotrueId)
  if (ctx.roles.length === 0) return { can: false, ctx }
  // Single-org deployment: default to the member's org slug. Org-scoped
  // routes (M3.1 member management) pass the path slug explicitly. A
  // multi-org future picks the org owning input.projectRef instead.
  const organizationSlug = input.orgSlug ?? ctx.roles[0].orgSlug
  const can = doPermissionsCheck(
    expandPermissions(ctx),
    input.action,
    input.resource,
    input.data,
    organizationSlug,
    input.projectRef
  )
  return { can, ctx }
}

export async function checkPermission(
  claims: JwtPayload | undefined,
  input: PermissionCheckInput
): Promise<boolean> {
  return (await checkPermissionWithContext(claims, input)).can
}

/**
 * Uniform [ref]-route guard: resolves the ref FIRST — an unknown ref throws
 * ProjectNotFound, which apiWrapper maps to 404 (spec §7.2: 404 before 403).
 * Then checks the permission and sends the 403 itself. Callers must
 * `return` immediately when this yields false. Only call under
 * IS_SELF_PLATFORM.
 */
export async function guardProjectRoute(
  res: NextApiResponse,
  claims: JwtPayload | undefined,
  input: { action: string; projectRef: string; resource?: string; data?: object }
): Promise<boolean> {
  await resolveProjectConnection(input.projectRef)
  const can = await checkPermission(claims, {
    action: input.action,
    resource: input.resource ?? 'projects',
    projectRef: input.projectRef,
    data: input.data,
  })
  if (!can) {
    res.status(403).json({ message: 'Forbidden' })
    return false
  }
  return true
}

export type OrgRouteContext = { orgId: number; orgSlug: string }

/**
 * Uniform org-slug-route guard (spec §7.2): 401 without claims; 404 when the
 * caller is not a member of the slug org (info hiding — unknown orgs and
 * non-member orgs are indistinguishable, M3.0 org-detail precedent); 403 when
 * the permission check denies. Mutating callers MUST pass
 * `data: { resource: { role_id } }` or the matrix owner-protection deny never
 * fires. Callers must `return` immediately on null. Only call under
 * IS_SELF_PLATFORM.
 */
export async function guardOrgRoute(
  res: NextApiResponse,
  claims: JwtPayload | undefined,
  input: { slug: string; action: string; resource?: string; data?: object }
): Promise<OrgRouteContext | null> {
  const gotrueId = claims?.sub
  if (!gotrueId) {
    res.status(401).json({ message: 'Unauthorized: missing token claims' })
    return null
  }
  const memberships = await listOrganizationsForProfile(gotrueId)
  const org = memberships.find((row) => row.slug === input.slug)
  if (!org) {
    res.status(404).json({ message: 'Organization not found' })
    return null
  }
  const can = await checkPermission(claims, {
    action: input.action,
    resource: input.resource ?? 'organizations',
    orgSlug: input.slug,
    data: input.data,
  })
  if (!can) {
    res.status(403).json({ message: 'Forbidden' })
    return null
  }
  return { orgId: org.id, orgSlug: org.slug }
}
