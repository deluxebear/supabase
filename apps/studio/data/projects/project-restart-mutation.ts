import { useMutation } from '@tanstack/react-query'
import type { components } from 'api-types'
import { toast } from 'sonner'

import { handleError, post } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type ProjectRestartVariables = {
  ref: string
  identifier?: string
}

type RestartProjectBody = components['schemas']['RestartProjectBody']

export async function restartProject({ ref, identifier }: ProjectRestartVariables) {
  const payload: RestartProjectBody = {}
  if (identifier !== undefined) payload.database_identifier = identifier

  const { data, error } = await post('/platform/projects/{ref}/restart', {
    params: { path: { ref } },
    body: payload,
  })
  if (error) handleError(error)
  return data
}

type ProjectRestartData = Awaited<ReturnType<typeof restartProject>>

export const useProjectRestartMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<ProjectRestartData, ResponseError, ProjectRestartVariables>,
  'mutationFn'
> = {}) => {
  return useMutation<ProjectRestartData, ResponseError, ProjectRestartVariables>({
    mutationFn: (vars) => restartProject(vars),
    async onSuccess(data, variables, context) {
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to restart project: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
