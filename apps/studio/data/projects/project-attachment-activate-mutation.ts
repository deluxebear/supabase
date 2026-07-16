import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'

import { projectKeys } from './keys'
import { handleError, post } from '@/data/fetchers'
import type { ResponseError } from '@/types'

export type ProjectAttachmentActivateVariables = { projectRef: string }
export type ProjectAttachmentActivateData = {
  projectRef: string
  connectionRevision: number
  attachmentState: 'active'
}

async function activateProjectAttachment({ projectRef }: ProjectAttachmentActivateVariables) {
  const { data, error } = await post(
    '/platform/projects/{ref}/attachment/activate' as never,
    { params: { path: { ref: projectRef } } } as never
  )
  if (error) handleError(error)
  return data as unknown as ProjectAttachmentActivateData
}

export const useProjectAttachmentActivateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<
    ProjectAttachmentActivateData,
    ResponseError,
    ProjectAttachmentActivateVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: activateProjectAttachment,
    async onSuccess(data, variables, context) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.projectRef) }),
        queryClient.invalidateQueries({
          queryKey: projectKeys.managementBinding(variables.projectRef),
        }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) toast.error(`Failed to activate project: ${error.message}`)
      else await onError(error, variables, context)
    },
    ...options,
  })
}
