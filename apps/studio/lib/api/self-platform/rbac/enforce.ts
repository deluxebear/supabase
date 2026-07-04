// [self-platform] Server-side RBAC enforcement (spec §7.2): platform GoTrue
// session (claims.sub) -> member roles -> matrix expansion -> the SAME
// evaluator the client uses. Fail closed: missing claims / zero roles /
// unknown role -> false. The subject is ALWAYS the dashboard session —
// never possession of a project's data-plane credential (spec §3.1,
// shared-stack JWT boundary).
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiResponse } from 'next'

import { getMemberContext, type MemberContext } from '../members'
import { getOrgMfaEnforced, listOrganizationsForProfile } from '../organizations'
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
  // [self-platform] M3.2: MFA enforcement must also cover routes that call
  // checkPermission directly (project detail, settings, credential routes), not
  // just the guardOrg/guardProjectRoute wrappers. When the resolved org enforces
  // MFA and the session is below aal2, deny here so every permission-gated route
  // blocks. The guards additionally emit the explicit 'MFA required' message
  // before reaching this point (they short-circuit), so their UX is unchanged;
  // direct-checkPermission routes return their own 403. (Extra getOrgMfaEnforced
  // lookup on the aal1 path — acceptable at internal scale; backlog: fold
  // enforce_mfa into getMemberContext to drop the round trip.)
  const mfaOrg = ctx.roles.find((r) => r.orgSlug === organizationSlug)
  if (mfaOrg && claims?.aal !== 'aal2' && (await getOrgMfaEnforced(mfaOrg.orgId))) {
    return { can: false, ctx }
  }
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
  // [self-platform] M3.2: MFA enforcement for project routes. Single-org: the
  // enforcing org is the member's org. Resolve it from the member context;
  // when the caller holds no roles the permission check below denies anyway.
  // Note: checkPermission internally re-fetches the member context below —
  // this is a known double round trip (backlog item, acceptable at internal scale).
  const ctx = await getMemberContext(claims?.sub ?? '')
  const orgId = ctx.roles[0]?.orgId
  // Order matches the checkPermissionWithContext chokepoint: check aal FIRST
  // so an aal2 session short-circuits before the getOrgMfaEnforced DB call.
  if (orgId !== undefined && claims?.aal !== 'aal2' && (await getOrgMfaEnforced(orgId))) {
    res.status(403).json({ message: 'MFA required to access this organization' })
    return false
  }
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
  // [self-platform] M3.2: org MFA enforcement. Members without an aal2 session
  // are blocked from every org route once the Owner enables enforce_mfa. Runs
  // AFTER the membership 404 so non-members never learn the org's MFA state.
  // Check aal FIRST so an aal2 session short-circuits before the
  // getOrgMfaEnforced DB call (matches the checkPermissionWithContext chokepoint).
  if (claims?.aal !== 'aal2' && (await getOrgMfaEnforced(org.id))) {
    res.status(403).json({ message: 'MFA required to access this organization' })
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
