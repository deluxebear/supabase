import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'

import { organizationKeys } from './keys'
import { del, handleError } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError } from '@/types'

export type ManagementTargetRevokeVariables = { slug: string; targetId: string }
export type ManagementTargetRevokeData = { id: string; state: 'revoked' }

async function revokeManagementTarget({ slug, targetId }: ManagementTargetRevokeVariables) {
  const { data, error } = await del(
    '/platform/organizations/{slug}/management-targets/{targetId}' as never,
    { params: { path: { slug, targetId } } } as never
  )
  if (error) handleError(error)
  return data as unknown as ManagementTargetRevokeData
}

export const useManagementTargetRevokeMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<ManagementTargetRevokeData, ResponseError, ManagementTargetRevokeVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: revokeManagementTarget,
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: organizationKeys.managementTargets(variables.slug),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined)
        toast.error($t('Failed to revoke management target: {{value0}}', { value0: error.message }))
      else await onError(error, variables, context)
    },
    ...options,
  })
}
