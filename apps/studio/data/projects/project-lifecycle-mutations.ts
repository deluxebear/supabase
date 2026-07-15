import { useMutation, UseMutationOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { constructHeaders } from '@/data/fetchers'
import {
  lifecycleImpactPlanSchema,
  type LifecycleExecuteInput,
  type LifecycleImpactPlan,
  type LifecyclePlanInput,
} from '@/lib/api/self-platform/lifecycle-contract'
import { ResponseError } from '@/types'

const planResponseSchema = z.object({
  plan: lifecycleImpactPlanSchema,
  expectedGeneration: z.number().int().nonnegative(),
})
const operationResponseSchema = z.object({
  operation: z.object({
    operationId: z.string(),
    revisionId: z.string().uuid(),
    generation: z.number().int().positive(),
    desiredDigest: z.string(),
    isReplayed: z.boolean(),
  }),
})

async function postLifecycle(projectRef: string, body: unknown, idempotencyKey?: string) {
  const response = await fetch(
    `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef)}/lifecycle`,
    {
      method: 'POST',
      headers: await constructHeaders({
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      }),
      body: JSON.stringify(body),
    }
  )
  const data: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const parsed = z.object({ message: z.string().optional() }).passthrough().safeParse(data)
    throw new ResponseError(
      parsed.success
        ? (parsed.data.message ?? 'Lifecycle request failed')
        : 'Lifecycle request failed',
      response.status
    )
  }
  return data
}

type LifecyclePlanResponse = { plan: LifecycleImpactPlan; expectedGeneration: number }
type LifecycleOperationResponse = {
  operation: {
    operationId: string
    revisionId: string
    generation: number
    desiredDigest: string
    isReplayed: boolean
  }
}
export type CreateLifecyclePlanVariables = {
  projectRef: string
  input: LifecyclePlanInput
}
export const useCreateLifecyclePlanMutation = (
  options: UseMutationOptions<
    LifecyclePlanResponse,
    ResponseError,
    CreateLifecyclePlanVariables
  > = {}
) =>
  useMutation({
    mutationFn: async ({ projectRef, input }) =>
      planResponseSchema.parse(await postLifecycle(projectRef, { phase: 'plan', input })),
    ...options,
  })

export type ExecuteLifecyclePlanVariables = {
  projectRef: string
  input: LifecycleExecuteInput
}
export const useExecuteLifecyclePlanMutation = (
  options: UseMutationOptions<
    LifecycleOperationResponse,
    ResponseError,
    ExecuteLifecyclePlanVariables
  > = {}
) =>
  useMutation({
    mutationFn: async ({ projectRef, input }) =>
      operationResponseSchema.parse(
        await postLifecycle(projectRef, { phase: 'execute', input }, input.idempotencyKey)
      ),
    ...options,
  })
