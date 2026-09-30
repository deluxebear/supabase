import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { edgeFunctionsKeys } from './keys'
import { constructHeaders, del, handleError } from '@/data/fetchers'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'
import { ResponseError, type UseCustomMutationOptions } from '@/types'

export type EdgeFunctionsDeleteVariables = {
  projectRef: string
  slug: string
  expectedGeneration?: number
}

export async function deleteEdgeFunction({
  projectRef,
  slug,
  expectedGeneration,
}: EdgeFunctionsDeleteVariables) {
  if (!projectRef) throw new Error('projectRef is required')

  if (STUDIO_DEPLOYMENT_PROFILE === 'fleet') {
    let generation = expectedGeneration
    if (generation === undefined) {
      const current = await fetch(
        `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef)}/functions`,
        { headers: await constructHeaders() }
      )
      const currentRaw: unknown = await current.json()
      if (!current.ok) {
        const error = z
          .object({ message: z.string().optional() })
          .passthrough()
          .safeParse(currentRaw)
        throw new ResponseError(
          error.success
            ? (error.data.message ?? 'Failed to load edge functions')
            : 'Failed to load edge functions',
          current.status
        )
      }
      const currentBody = z
        .object({
          functions: z.array(z.object({ slug: z.string(), generation: z.number().int() })),
        })
        .parse(currentRaw)
      generation = currentBody.functions.find((item) => item.slug === slug)?.generation
    }
    if (!Number.isInteger(generation) || (generation ?? 0) < 1) {
      throw new ResponseError('Function deployment generation is unavailable', 409)
    }
    const response = await fetch(
      `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef)}/functions`,
      {
        method: 'DELETE',
        headers: await constructHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': uuidv4(),
        }),
        body: JSON.stringify({ slug, expectedGeneration: generation }),
      }
    )
    const raw: unknown = await response.json()
    if (!response.ok) {
      const error = z.object({ message: z.string().optional() }).passthrough().safeParse(raw)
      throw new ResponseError(
        error.success
          ? (error.data.message ?? 'Failed to delete edge function')
          : 'Failed to delete edge function',
        response.status
      )
    }
    return z
      .object({
        deployment: z.object({ slug: z.string(), generation: z.number().int() }).passthrough(),
      })
      .parse(raw)
  }

  const { data, error } = await del(`/v1/projects/{ref}/functions/{function_slug}`, {
    params: {
      path: { ref: projectRef, function_slug: slug },
    },
  })

  if (error) handleError(error)
  return data
}

type EdgeFunctionsDeleteData = Awaited<ReturnType<typeof deleteEdgeFunction>>

export const useEdgeFunctionDeleteMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<EdgeFunctionsDeleteData, ResponseError, EdgeFunctionsDeleteVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<EdgeFunctionsDeleteData, ResponseError, EdgeFunctionsDeleteVariables>({
    mutationFn: (vars) => deleteEdgeFunction(vars),
    async onSuccess(data, variables, context) {
      const { projectRef } = variables
      await queryClient.invalidateQueries({
        queryKey: edgeFunctionsKeys.list(projectRef),
        refetchType: 'all',
      })
      await queryClient.invalidateQueries({
        queryKey: edgeFunctionsKeys.deployments(projectRef),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to delete edge function: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
