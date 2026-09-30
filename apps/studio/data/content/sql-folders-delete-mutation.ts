import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { contentKeys } from './keys'
import { del, handleError } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type DeleteSQLSnippetFoldersVariables = {
  projectRef: string
  ids: string[]
}

export async function deleteSQLSnippetFolders(
  { projectRef, ids }: DeleteSQLSnippetFoldersVariables,
  signal?: AbortSignal
) {
  const { data, error } = await del('/platform/projects/{ref}/content/folders', {
    // @ts-expect-error The generated endpoint type omits its required `{ref}` path parameter.
    params: { path: { ref: projectRef }, query: { ids: ids.join(',') } },
    signal,
  })

  if (error) throw handleError(error)
  return data
}

export type DeleteSQLSnippetFoldersData = Awaited<ReturnType<typeof deleteSQLSnippetFolders>>

export const useSQLSnippetFoldersDeleteMutation = ({
  onError,
  onSuccess,
  invalidateQueriesOnSuccess = true,
  ...options
}: Omit<
  UseCustomMutationOptions<
    DeleteSQLSnippetFoldersData,
    ResponseError,
    DeleteSQLSnippetFoldersVariables
  >,
  'mutationFn'
> & {
  invalidateQueriesOnSuccess?: boolean
} = {}) => {
  const queryClient = useQueryClient()

  return useMutation<DeleteSQLSnippetFoldersData, ResponseError, DeleteSQLSnippetFoldersVariables>({
    mutationFn: (args) => deleteSQLSnippetFolders(args),
    async onSuccess(data, variables, context) {
      const { projectRef } = variables
      if (invalidateQueriesOnSuccess) {
        await queryClient.invalidateQueries({ queryKey: contentKeys.folders(projectRef) })
      }
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to delete folder: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
