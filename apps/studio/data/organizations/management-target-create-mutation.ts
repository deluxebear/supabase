import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'

import { organizationKeys } from './keys'
import { handleError, post } from '@/data/fetchers'
import {
  managementTargetResponseSchema,
  type ManagementTargetCreatePayload,
  type ManagementTargetResponse,
} from '@/data/management-trust/types'
import { t as $t } from '@/lib/i18n'
import type { ResponseError } from '@/types'

export type ManagementTargetCreateVariables = {
  slug: string
  payload: ManagementTargetCreatePayload
}

async function createManagementTarget({ slug, payload }: ManagementTargetCreateVariables) {
  if (!slug) throw new Error('slug is required')
  const { data, error } = await post(
    '/platform/organizations/{slug}/management-targets' as never,
    { params: { path: { slug } }, body: payload } as never
  )
  if (error) handleError(error)
  return managementTargetResponseSchema.parse(data)
}

export const useManagementTargetCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<ManagementTargetResponse, ResponseError, ManagementTargetCreateVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createManagementTarget,
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: organizationKeys.managementTargets(variables.slug),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined)
        toast.error($t('Failed to create management target: {{value0}}', { value0: error.message }))
      else await onError(error, variables, context)
    },
    ...options,
  })
}
