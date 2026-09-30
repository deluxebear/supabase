import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { configKeys } from './keys'
import { fetchGet, fetchPost } from '@/data/fetchers'
import { API_URL } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { t as $t } from '@/lib/i18n'
import { ResponseError } from '@/types'

const statusSchema = z.object({
  availability: z.discriminatedUnion('isAvailable', [
    z.object({ isAvailable: z.literal(true) }),
    z.object({ isAvailable: z.literal(false), code: z.string(), message: z.string() }),
  ]),
  state: z.enum(['nothing-to-apply', 'pending', 'applying', 'applied', 'failed']),
  expectedGeneration: z.number().int().nonnegative(),
  isOwnedByFleet: z.boolean(),
  observedAt: z.string().nullable(),
  recipientPublicKey: z.string(),
  services: z.array(z.string()),
  operation: z
    .object({
      id: z.string(),
      state: z.string(),
      errorCode: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
})
const url = (ref: string) => `${API_URL}/platform/projects/${encodeURIComponent(ref)}/config/jwt`

export const jwtConfigurationQueryOptions = ({ projectRef }: { projectRef?: string }) =>
  queryOptions({
    queryKey: configKeys.jwtConfiguration(projectRef),
    queryFn: async ({ signal }) => {
      if (!projectRef) throw new Error('projectRef is required')
      const response = await fetchGet<unknown>(url(projectRef), { abortSignal: signal })
      if (response instanceof ResponseError) throw response
      return statusSchema.parse(response)
    },
    enabled: IS_SELF_PLATFORM && !!projectRef,
    refetchInterval: 15_000,
  })

export const useJWTConfigurationMutation = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      projectRef: string
      secret: string
      expectedGeneration: number
      confirmOwnership: boolean
      confirmTokenInvalidation: true
      idempotencyKey: string
    }) => {
      const { projectRef, idempotencyKey, ...body } = input
      const response = await fetchPost<unknown>(url(projectRef), body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      })
      if (response instanceof ResponseError) throw response
      return response
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: configKeys.jwtConfiguration(variables.projectRef) }),
        client.invalidateQueries({ queryKey: configKeys.postgrest(variables.projectRef) }),
      ])
    },
    onError: (error: Error) =>
      toast.error($t('Failed to apply JWT configuration: {{value0}}', { value0: error.message })),
  })
}
