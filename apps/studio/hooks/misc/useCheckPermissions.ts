import { useIsLoggedIn, useParams } from 'common'
import { useMemo } from 'react'

import { useSelectedOrganizationQuery } from './useSelectedOrganization'
import { useSelectedProjectQuery } from './useSelectedProject'
import { usePermissionsQuery } from '@/data/permissions/permissions-query'
import { IS_PLATFORM } from '@/lib/constants'
// [self-platform] Evaluator extracted to lib/permissions-check.ts so the
// server-side RBAC enforcement shares it. Re-exported for existing
// consumers (TeamSettings.utils, InviteMemberButton, ...).
import { doPermissionsCheck } from '@/lib/permissions-check'
import type { Permission } from '@/types'

export { doPermissionsCheck }

export function useGetPermissions(
  permissionsOverride?: Permission[],
  organizationSlugOverride?: string,
  enabled = true
) {
  return useGetProjectPermissions(permissionsOverride, organizationSlugOverride, undefined, enabled)
}

function useGetProjectPermissions(
  permissionsOverride?: Permission[],
  organizationSlugOverride?: string,
  projectRefOverride?: string,
  enabled = true
) {
  const {
    data,
    isPending: isLoadingPermissions,
    isSuccess: isSuccessPermissions,
  } = usePermissionsQuery({
    enabled: permissionsOverride === undefined && enabled,
  })
  const permissions = permissionsOverride === undefined ? data : permissionsOverride

  const getOrganizationDataFromParamsSlug = organizationSlugOverride === undefined && enabled
  const {
    data: organizationData,
    isPending: isLoadingOrganization,
    isSuccess: isSuccessOrganization,
  } = useSelectedOrganizationQuery({
    enabled: getOrganizationDataFromParamsSlug,
  })
  const organization =
    organizationSlugOverride === undefined ? organizationData : { slug: organizationSlugOverride }
  const organizationSlug = organization?.slug

  const { ref: urlProjectRef } = useParams()
  const getProjectDataFromParamsRef = !!urlProjectRef && projectRefOverride === undefined && enabled
  const {
    data: projectData,
    isPending: isLoadingProject,
    isSuccess: isSuccessProject,
  } = useSelectedProjectQuery({
    enabled: getProjectDataFromParamsRef,
  })
  const project =
    projectRefOverride === undefined || projectData?.parent_project_ref
      ? projectData
      : { ref: projectRefOverride, parent_project_ref: undefined }

  const projectRef = project?.parent_project_ref ? project.parent_project_ref : project?.ref

  const isLoading =
    isLoadingPermissions ||
    (getOrganizationDataFromParamsSlug && isLoadingOrganization) ||
    (getProjectDataFromParamsRef && isLoadingProject)
  const isSuccess =
    isSuccessPermissions &&
    (!getOrganizationDataFromParamsSlug || isSuccessOrganization) &&
    (!getProjectDataFromParamsRef || isSuccessProject)

  return {
    permissions,
    organizationSlug,
    projectRef,
    isLoading,
    isSuccess,
  }
}

/** [Joshen] To be renamed to be useAsyncCheckPermissions, more generic as it covers both org and project perms */
// Useful when you want to avoid layout changes while waiting for permissions to load
export function useAsyncCheckPermissions(
  action: string,
  resource: string,
  data?: object,
  overrides?: {
    organizationSlug?: string
    projectRef?: string
    permissions?: Permission[]
  }
) {
  const isLoggedIn = useIsLoggedIn()
  const { organizationSlug, projectRef, permissions } = overrides ?? {}

  const {
    permissions: allPermissions,
    organizationSlug: _organizationSlug,
    projectRef: _projectRef,
    isLoading: isPermissionsLoading,
    isSuccess: isPermissionsSuccess,
  } = useGetProjectPermissions(permissions, organizationSlug, projectRef, isLoggedIn)

  const can = useMemo(() => {
    if (!IS_PLATFORM) return true
    if (!isLoggedIn) return false
    if (!isPermissionsSuccess || !allPermissions) return false

    return doPermissionsCheck(
      allPermissions,
      action,
      resource,
      data,
      _organizationSlug,
      _projectRef
    )
  }, [
    isLoggedIn,
    isPermissionsSuccess,
    allPermissions,
    action,
    resource,
    data,
    _organizationSlug,
    _projectRef,
  ])

  // Derive loading/success consistently from the same branches
  const isLoading = !IS_PLATFORM ? false : !isLoggedIn ? true : isPermissionsLoading

  const isSuccess = !IS_PLATFORM ? true : !isLoggedIn ? false : isPermissionsSuccess

  return { isLoading, isSuccess, can }
}
