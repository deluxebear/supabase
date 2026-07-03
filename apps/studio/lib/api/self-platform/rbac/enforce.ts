// [self-platform] Server-side RBAC enforcement (spec §7.2): platform GoTrue
// session (claims.sub) -> member roles -> matrix expansion -> the SAME
// evaluator the client uses. Fail closed: missing claims / zero roles /
// unknown role -> false. The subject is ALWAYS the dashboard session —
// never possession of a project's data-plane credential (spec §3.1,
// shared-stack JWT boundary).
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiResponse } from 'next'

import { getMemberContext, type MemberContext } from '../members'
import { resolveProjectConnection } from '../resolve-connection'
import { expandPermissions } from './expand'
import { doPermissionsCheck } from '@/lib/permissions-check'

export type PermissionCheckInput = {
  action: string
  resource: string
  projectRef?: string
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
  // Single-org deployment: evaluate against the member's org slug. A
  // multi-org future picks the org owning input.projectRef instead (M3.1+).
  const organizationSlug = ctx.roles[0].orgSlug
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
