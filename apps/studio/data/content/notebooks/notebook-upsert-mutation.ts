import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { upsertContent, type UpsertContentPayload } from '../content-upsert-mutation'
import { contentKeys } from '../keys'
import { writableNotebookSchema, type WritableNotebook } from './notebook-schema'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

function buildNotebookUpsertPayload({
  id,
  name,
  description,
  content,
}: {
  id: string
  name: string
  description?: string
  content: WritableNotebook
}): UpsertContentPayload {
  return {
    id,
    name,
    description,
    type: 'notebook',
    visibility: 'project',
    content: writableNotebookSchema.parse(content),
  }
}

export type CreateNotebookVariables = {
  projectRef: string
  name: string
  description?: string
  content: WritableNotebook
}

export async function createNotebook(
  { projectRef, name, description, content }: CreateNotebookVariables,
  signal?: AbortSignal,
  headersInit?: HeadersInit
) {
  const id = uuidv4()
  const payload = buildNotebookUpsertPayload({ id, name, description, content })

  await upsertContent({ projectRef, payload }, signal, headersInit)

  return { id }
}

export type CreateNotebookData = Awaited<ReturnType<typeof createNotebook>>

export type UpsertNotebookVariables = {
  id: string
  projectRef: string
  name: string
  description?: string
  content: WritableNotebook
}

export async function upsertNotebook(
  { projectRef, id, name, description, content }: UpsertNotebookVariables,
  signal?: AbortSignal,
  headersInit?: HeadersInit
) {
  const payload = buildNotebookUpsertPayload({ id, name, description, content })

  return upsertContent({ projectRef, payload }, signal, headersInit)
}

export type UpdateNotebookData = Awaited<ReturnType<typeof upsertNotebook>>

export const useUpsertNotebookMutation = <TContext = unknown>({
  onError,
  onSuccess,
  ...options
}: Omit<
  UseCustomMutationOptions<UpdateNotebookData, ResponseError, UpsertNotebookVariables, TContext>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<UpdateNotebookData, ResponseError, UpsertNotebookVariables, TContext>({
    mutationFn: (args) => upsertNotebook(args),
    async onSuccess(data, variables, context) {
      const { projectRef, id } = variables
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: contentKeys.allContentLists(projectRef) }),
        queryClient.invalidateQueries({ queryKey: contentKeys.infiniteList(projectRef) }),
        queryClient.invalidateQueries({ queryKey: contentKeys.resource(projectRef, id) }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to update notebook: {{value0}}', { value0: error.message }))
      } else {
        onError(error, variables, context)
      }
    },
    ...options,
  })
}
