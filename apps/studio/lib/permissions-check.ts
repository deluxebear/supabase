// [self-platform] Pure permission evaluator, extracted from
// hooks/misc/useCheckPermissions.ts so server-side RBAC enforcement
// (lib/api/self-platform/rbac/) and the client hooks share ONE
// implementation. No React/browser dependencies.
//
// Deltas vs the pre-extraction hook code (intentional):
// - PermissionGrant is structural so both the client Permission type and
//   api-types AccessControlPermission (nullable fields) fit without casts.
// - `actions`/`resources` null-guarded with `?? []`.
import jsonLogic from 'json-logic-js'

export type PermissionGrant = {
  actions: string[] | null
  condition: unknown
  organization_slug: string
  project_refs: string[] | null
  resources: string[] | null
  restrictive?: boolean | null
}

const toRegexpString = (actionOrResource: string) =>
  `^${actionOrResource.replace('.', '\\.').replace('%', '.*')}$`

export function doPermissionConditionCheck(permissions: PermissionGrant[], data?: object) {
  const isRestricted = permissions
    .filter((permission) => permission.restrictive)
    .some(
      ({ condition }) =>
        condition === null || jsonLogic.apply(condition as jsonLogic.RulesLogic, data)
    )
  if (isRestricted) return false

  return permissions
    .filter((permission) => !permission.restrictive)
    .some(
      ({ condition }) =>
        condition === null || jsonLogic.apply(condition as jsonLogic.RulesLogic, data)
    )
}

export function doPermissionsCheck(
  permissions: PermissionGrant[] | undefined,
  action: string,
  resource: string,
  data?: object,
  organizationSlug?: string,
  projectRef?: string
) {
  if (!permissions || !Array.isArray(permissions)) {
    return false
  }

  if (projectRef) {
    const projectPermissions = permissions.filter(
      (permission) =>
        permission.organization_slug === organizationSlug &&
        (permission.actions ?? []).some((act) =>
          action ? action.match(toRegexpString(act)) : null
        ) &&
        (permission.resources ?? []).some((res) => resource.match(toRegexpString(res))) &&
        permission.project_refs?.includes(projectRef)
    )
    if (projectPermissions.length > 0) {
      return doPermissionConditionCheck(projectPermissions, { resource_name: resource, ...data })
    }
  }

  const orgPermissions = permissions
    // filter out org-level permission
    .filter((permission) => !permission.project_refs || permission.project_refs.length === 0)
    .filter(
      (permission) =>
        permission.organization_slug === organizationSlug &&
        (permission.actions ?? []).some((act) =>
          action ? action.match(toRegexpString(act)) : null
        ) &&
        (permission.resources ?? []).some((res) => resource.match(toRegexpString(res)))
    )
  return doPermissionConditionCheck(orgPermissions, { resource_name: resource, ...data })
}
