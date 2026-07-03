// [self-platform] MemberContext -> AccessControlPermission[] expansion.
// Org-scoped roles expand with empty project lists (org-wide); derived
// roles carry their role_projects scope, using the BASE role's templates.
import type { components } from 'api-types'

import type { MemberContext } from '../members'
import { BASE_ROLE_ORDER, ROLE_MATRIX } from './matrix'

type AccessControlPermission = components['schemas']['AccessControlPermission']

export function expandPermissions(ctx: MemberContext): AccessControlPermission[] {
  const out: AccessControlPermission[] = []
  for (const role of ctx.roles) {
    const templates = ROLE_MATRIX[role.baseRoleName]
    // Unknown base role: grant nothing (fail closed).
    if (!templates) continue
    for (const template of templates) {
      out.push({
        actions: template.actions,
        resources: template.resources,
        condition: template.condition,
        organization_id: role.orgId,
        organization_slug: role.orgSlug,
        project_ids: role.projectIds,
        project_refs: role.projectRefs,
        restrictive: template.restrictive ?? false,
      })
    }
  }
  return out
}

/**
 * Strongest base role the member holds that applies to `projectRef`
 * (org-scoped roles apply to every project of their org; derived roles only
 * to their listed refs). Used for the Read-only data-plane connection choice.
 */
export function effectiveBaseRoleName(ctx: MemberContext, projectRef: string): string | null {
  let best: string | null = null
  let bestIdx = BASE_ROLE_ORDER.length
  for (const role of ctx.roles) {
    const applies = role.projectRefs.length === 0 || role.projectRefs.includes(projectRef)
    if (!applies) continue
    const idx = BASE_ROLE_ORDER.indexOf(role.baseRoleName)
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx
      best = role.baseRoleName
    }
  }
  return best
}
