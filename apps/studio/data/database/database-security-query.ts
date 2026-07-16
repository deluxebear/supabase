import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { constructHeaders } from '@/data/fetchers'
import { ResponseError } from '@/types'

export const databaseSecurityPolicySchema = z.object({
  generation: z.number().int().nonnegative(),
  ssl: z.object({ enforced: z.boolean(), caReference: z.string() }),
  network: z.object({ allowedCidrs: z.array(z.string()) }),
  pooler: z.object({
    defaultPoolSize: z.number().int(),
    maxClientConnections: z.number().int(),
  }),
  state: z.enum(['ready', 'applying', 'failed']),
  operationId: z.string().nullable(),
  errorCode: z.string().nullable(),
  observedAt: z.string().nullable(),
})

export type DatabaseSecurityPolicy = z.infer<typeof databaseSecurityPolicySchema>
const keys = {
  policy: (projectRef?: string) => ['projects', projectRef, 'database-security'] as const,
}

async function parseResponse(response: Response) {
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new ResponseError('Database security API returned invalid JSON', response.status)
  }
  if (!response.ok) {
    const parsed = z.object({ message: z.string().optional() }).passthrough().safeParse(body)
    throw new ResponseError(
      parsed.success
        ? (parsed.data.message ?? 'Database security request failed')
        : 'Database security request failed',
      response.status
    )
  }
  return body
}

export function useDatabaseSecurityQuery(projectRef?: string) {
  return useQuery({
    queryKey: keys.policy(projectRef),
    enabled: projectRef !== undefined,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef!)}/database-security`,
        { headers: await constructHeaders(), signal }
      )
      return z.object({ policy: databaseSecurityPolicySchema }).parse(await parseResponse(response))
        .policy
    },
  })
}

export function useUpdateDatabaseSecurityMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      projectRef: string
      policy: Pick<DatabaseSecurityPolicy, 'ssl' | 'network' | 'pooler'>
      expectedGeneration: number
    }) => {
      const response = await fetch(
        `/api/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/database-security`,
        {
          method: 'PATCH',
          headers: await constructHeaders({
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          }),
          body: JSON.stringify({ ...input.policy, expectedGeneration: input.expectedGeneration }),
        }
      )
      return z.object({ policy: databaseSecurityPolicySchema }).parse(await parseResponse(response))
        .policy
    },
    onSuccess: async (policy, variables) => {
      queryClient.setQueryData(keys.policy(variables.projectRef), policy)
      toast.success('Database security settings updated')
    },
    onError: (error: ResponseError) => toast.error(error.message),
  })
}

export function useRotateDatabasePasswordMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      projectRef: string
      expectedGeneration: number
      role: 'primary' | 'read-only'
      newPassword: string
    }) => {
      const response = await fetch(
        `/api/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/database-security/password`,
        {
          method: 'POST',
          headers: await constructHeaders({
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          }),
          body: JSON.stringify({
            expectedGeneration: input.expectedGeneration,
            role: input.role,
            newPassword: input.newPassword,
          }),
        }
      )
      await parseResponse(response)
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: keys.policy(variables.projectRef) })
      toast.success('Database password rotated and the platform connection was updated')
    },
    onError: (error: ResponseError) => toast.error(error.message),
  })
}
