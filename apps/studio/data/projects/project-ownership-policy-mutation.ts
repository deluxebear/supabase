import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { projectKeys } from './keys'
import { handleError, put } from '@/data/fetchers'
import {
  ownershipModeSchema,
  ownershipPolicySchema,
  type OwnershipPolicy,
} from '@/lib/api/self-platform/ownership-policy'
import { t as $t } from '@/lib/i18n'
import type { ResponseError } from '@/types'

type Variables = {
  projectRef: string
  domain: string
  ownershipMode: z.infer<typeof ownershipModeSchema>
  expectedRevision: number
}

const responseSchema = z.object({ policy: ownershipPolicySchema })

async function updateOwnershipPolicy({ projectRef, ...body }: Variables) {
  const { data, error } = await put(
    '/platform/projects/{ref}/ownership-policies' as never,
    { params: { path: { ref: projectRef } }, body } as never
  )
  if (error) handleError(error)
  return responseSchema.parse(data).policy
}

export const useProjectOwnershipPolicyMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<UseMutationOptions<OwnershipPolicy, ResponseError, Variables>, 'mutationFn'> = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateOwnershipPolicy,
    async onSuccess(data, variables, context) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectKeys.ownershipPolicies(variables.projectRef),
        }),
        queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.projectRef) }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) {
        toast.error(`${$t('Failed to update configuration ownership')}: ${error.message}`)
      } else await onError(error, variables, context)
    },
    ...options,
  })
}
