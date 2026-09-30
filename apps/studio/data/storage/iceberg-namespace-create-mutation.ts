import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { storageKeys } from './keys'
import { handleError, post } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

type CreateIcebergNamespaceVariables = {
  projectRef?: string
  warehouse: string
  namespace: string
}

async function createIcebergNamespace({
  projectRef,
  warehouse,
  namespace,
}: CreateIcebergNamespaceVariables) {
  if (!projectRef) throw new Error('projectRef is required')

  const { error } = await post('/platform/storage/{ref}/analytics-buckets/{id}/namespaces', {
    params: { path: { ref: projectRef, id: warehouse } },
    body: { namespace },
  })

  if (error) handleError(error)
  return true
}

type IcebergNamespaceCreateData = Awaited<ReturnType<typeof createIcebergNamespace>>

export const useIcebergNamespaceCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<
    IcebergNamespaceCreateData,
    ResponseError,
    CreateIcebergNamespaceVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<IcebergNamespaceCreateData, ResponseError, CreateIcebergNamespaceVariables>({
    mutationFn: (vars) => createIcebergNamespace({ ...vars }),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: storageKeys.icebergNamespaces({
          projectRef: variables.projectRef,
          warehouse: variables.warehouse,
        }),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (data.message === 'Request failed with status code 409') {
        toast.error(
          $t('A namespace named {{value0}} already exists in the catalog.', {
            value0: variables.namespace,
          })
        )
        return
      }
      if (onError === undefined) {
        toast.error($t('Failed to create Iceberg namespace: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
