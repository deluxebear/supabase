import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { organizationKeys } from './keys'
import { del, handleError } from '@/data/fetchers'
import { organizationKeys as organizationKeysV1 } from '@/data/organizations/keys'
import { invalidatePermissionsQuery } from '@/data/permissions/permissions-query'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type OrganizationMemberUnassignRoleVariables = {
  slug: string
  gotrueId: string
  roleId: number
  skipInvalidation?: boolean
}

export async function unassignOrganizationMemberRole({
  slug,
  gotrueId,
  roleId,
}: OrganizationMemberUnassignRoleVariables) {
  const { data, error } = await del(
    '/platform/organizations/{slug}/members/{gotrue_id}/roles/{role_id}',
    {
      params: {
        path: {
          slug,
          gotrue_id: gotrueId,
          role_id: roleId,
        },
      },
    }
  )

  if (error) handleError(error)
  return data
}

type OrganizationMemberUnassignRoleData = Awaited<ReturnType<typeof unassignOrganizationMemberRole>>

export const useOrganizationMemberUnassignRoleMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<
    OrganizationMemberUnassignRoleData,
    ResponseError,
    OrganizationMemberUnassignRoleVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<
    OrganizationMemberUnassignRoleData,
    ResponseError,
    OrganizationMemberUnassignRoleVariables
  >({
    mutationFn: (vars) => unassignOrganizationMemberRole(vars),
    async onSuccess(data, variables, context) {
      const { slug, skipInvalidation } = variables

      if (!skipInvalidation) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: organizationKeys.rolesV2(slug) }),
          queryClient.invalidateQueries({ queryKey: organizationKeysV1.members(slug) }),
          // [self-platform] M3.1: role changes affect the CALLER's own
          // permission set when self-editing; permissions-query staleTime is
          // 5 minutes, so invalidate explicitly.
          invalidatePermissionsQuery(queryClient),
        ])
      }

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to unassign member role: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
