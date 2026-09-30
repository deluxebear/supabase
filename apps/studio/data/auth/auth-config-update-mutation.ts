import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { configKeys } from '../config/keys'
import { authKeys } from './keys'
import type { components } from '@/data/api'
import { handleError, patch } from '@/data/fetchers'
import { lintKeys } from '@/data/lint/keys'
import { IS_AUTH_CONFIGURATION_DESIRED_STATE_ONLY } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type AuthConfigUpdateVariables = {
  projectRef: string
  config: Partial<components['schemas']['UpdateGoTrueConfigBody']>
  skipInvalidation?: boolean
}

export async function updateAuthConfig({ projectRef, config }: AuthConfigUpdateVariables) {
  const { data, error } = await patch('/platform/auth/{ref}/config', {
    params: {
      path: { ref: projectRef },
    },
    body: {
      ...config,
    },
  })

  if (error) handleError(error)
  return data
}

type AuthConfigUpdateData = Awaited<ReturnType<typeof updateAuthConfig>>

export const useAuthConfigUpdateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<AuthConfigUpdateData, ResponseError, AuthConfigUpdateVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<AuthConfigUpdateData, ResponseError, AuthConfigUpdateVariables>({
    mutationFn: (vars) => updateAuthConfig(vars),
    async onSuccess(data, variables, context) {
      const { projectRef, skipInvalidation = false } = variables

      if (!skipInvalidation) {
        await queryClient.invalidateQueries({
          queryKey: authKeys.authConfig(projectRef),
        })
      }

      await onSuccess?.(data, variables, context)

      // [self-platform] Fleet records Auth settings as desired state only. The
      // caller's success toast confirms the save; this one says it is not live.
      if (IS_AUTH_CONFIGURATION_DESIRED_STATE_ONLY) {
        toast.info($t('Saved in Fleet, not applied'), {
          id: 'auth-config-desired-state-only',
          description: $t(
            "The project's Auth service keeps its current configuration until you apply the saved settings."
          ),
        })
      }

      Promise.all([
        queryClient.invalidateQueries({ queryKey: lintKeys.lint(projectRef) }),
        queryClient.invalidateQueries({ queryKey: configKeys.projectConfig(projectRef) }),
      ])
        .then(() =>
          queryClient.refetchQueries({
            queryKey: lintKeys.lint(projectRef),
            type: 'active',
          })
        )
        .catch(() => undefined)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to update auth configuration: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
