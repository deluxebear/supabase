import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { PostgresEngine, ReleaseChannel } from './new-project.constants'
import { handleError, post } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type ProjectRestoreVariables = {
  ref: string
  postgresEngine?: Exclude<PostgresEngine, '13' | '14'>
  releaseChannel?: ReleaseChannel
}

export async function restoreProject({
  ref,
  postgresEngine,
  releaseChannel,
}: ProjectRestoreVariables) {
  const { data, error } = await post('/platform/projects/{ref}/restore', {
    params: { path: { ref } },
    body: {
      postgres_engine: postgresEngine,
      release_channel: releaseChannel,
    },
  })
  if (error) handleError(error)
  return data
}

type ProjectRestoreData = Awaited<ReturnType<typeof restoreProject>>

export const useProjectRestoreMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<ProjectRestoreData, ResponseError, ProjectRestoreVariables>,
  'mutationFn'
> = {}) => {
  return useMutation<ProjectRestoreData, ResponseError, ProjectRestoreVariables>({
    mutationFn: (vars) => restoreProject(vars),
    async onSuccess(data, variables, context) {
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to restore project: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
