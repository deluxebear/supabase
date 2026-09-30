import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'

import { handleAPIKeyMutationError, showAPIKeyMfaAction } from './api-key-errors'
import { apiKeysKeys } from './keys'
import { post } from '@/data/fetchers'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type APIKeyCreateVariables = {
  projectRef?: string
  name: string
  description?: string
} & ({ type: 'publishable' } | { type: 'secret' })

export async function createAPIKey(payload: APIKeyCreateVariables) {
  if (!payload.projectRef) throw new Error('projectRef is required')

  const { data, error } = await post('/v1/projects/{ref}/api-keys', {
    ...(STUDIO_DEPLOYMENT_PROFILE === 'fleet' ? { headers: { 'Idempotency-Key': uuidv4() } } : {}),
    params: {
      path: { ref: payload.projectRef },
      query: {
        reveal: 'false',
      },
    },
    body: {
      ...(payload.type === 'secret'
        ? {
            // secret_jwt_template: payload?.secret_jwt_template || null,
            secret_jwt_template: {
              role: 'service_role',
            },
          }
        : {}),

      type: payload.type,
      name: payload.name,
      description: payload.description || null,
    },
  })

  if (error) handleAPIKeyMutationError(error)
  return data
}

type APIKeyCreateData = Awaited<ReturnType<typeof createAPIKey>>

export const useAPIKeyCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<APIKeyCreateData, ResponseError, APIKeyCreateVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<APIKeyCreateData, ResponseError, APIKeyCreateVariables>({
    mutationFn: (vars) => createAPIKey(vars),
    async onSuccess(data, variables, context) {
      const { projectRef } = variables

      await queryClient.invalidateQueries({ queryKey: apiKeysKeys.list(projectRef) })

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (await showAPIKeyMfaAction(data, queryClient)) return
      if (onError === undefined) {
        toast.error($t('Failed to create API key: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
