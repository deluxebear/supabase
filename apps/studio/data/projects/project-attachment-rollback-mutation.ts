import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'

import { projectKeys } from './keys'
import { useInvalidateProjectsInfiniteQuery } from './org-projects-infinite-query'
import { handleError, post } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError } from '@/types'

export type ProjectAttachmentRollbackVariables = {
  projectRef: string
  organizationSlug?: string
}
export type ProjectAttachmentRollbackData = {
  projectRef: string
  rolledBackAt: string
  infrastructureDeleted: false
}

async function rollbackProjectAttachment({ projectRef }: ProjectAttachmentRollbackVariables) {
  const { data, error } = await post(
    '/platform/projects/{ref}/attachment/rollback' as never,
    { params: { path: { ref: projectRef } } } as never
  )
  if (error) handleError(error)
  return data as unknown as ProjectAttachmentRollbackData
}

export const useProjectAttachmentRollbackMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<
    ProjectAttachmentRollbackData,
    ResponseError,
    ProjectAttachmentRollbackVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  const { invalidateProjectsQuery } = useInvalidateProjectsInfiniteQuery()
  return useMutation({
    mutationFn: rollbackProjectAttachment,
    async onSuccess(data, variables, context) {
      await Promise.all([
        invalidateProjectsQuery(),
        queryClient.removeQueries({ queryKey: projectKeys.detail(variables.projectRef) }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined)
        toast.error($t('Failed to roll back attachment: {{value0}}', { value0: error.message }))
      else await onError(error, variables, context)
    },
    ...options,
  })
}
