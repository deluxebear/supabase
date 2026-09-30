import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'

import { handleAPIKeyMutationError, showAPIKeyMfaAction } from './api-key-errors'
import { apiKeysKeys } from './keys'
import { del } from '@/data/fetchers'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type APIKeyDeleteVariables = {
  projectRef?: string
  id: string
}

export async function deleteAPIKey(payload: APIKeyDeleteVariables) {
  if (!payload.projectRef) throw new Error('projectRef is required')

  const { data, error } = await del('/v1/projects/{ref}/api-keys/{id}', {
    ...(STUDIO_DEPLOYMENT_PROFILE === 'fleet' ? { headers: { 'Idempotency-Key': uuidv4() } } : {}),
    params: {
      path: { ref: payload.projectRef, id: payload.id },
      query: { reveal: 'false' },
    },
  })

  if (error) handleAPIKeyMutationError(error)
  return data
}

type APIKeyDeleteData = Awaited<ReturnType<typeof deleteAPIKey>>

export const useAPIKeyDeleteMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<APIKeyDeleteData, ResponseError, APIKeyDeleteVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<APIKeyDeleteData, ResponseError, APIKeyDeleteVariables>({
    mutationFn: (vars) => deleteAPIKey(vars),
    async onSuccess(data, variables, context) {
      const { projectRef } = variables

      await queryClient.invalidateQueries({ queryKey: apiKeysKeys.list(projectRef) })

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (await showAPIKeyMfaAction(data, queryClient)) return
      if (onError === undefined) {
        toast.error($t('Failed to delete API key: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
