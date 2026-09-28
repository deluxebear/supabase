// [self-platform] Phase 2: apply stored Auth settings to the Fleet-managed
// Auth service, and read whether the running service uses them.
import {
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { authKeys } from './keys'
import { constructHeaders } from '@/data/fetchers'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { ResponseError } from '@/types'

const operationSchema = z.object({
  id: z.string(),
  state: z.string(),
  errorCode: z.string().nullable(),
  updatedAt: z.string(),
})

const authConfigApplyStatusSchema = z.object({
  availability: z.discriminatedUnion('isAvailable', [
    z.object({ isAvailable: z.literal(true) }),
    z.object({ isAvailable: z.literal(false), code: z.string(), message: z.string() }),
  ]),
  state: z.enum(['nothing-to-apply', 'pending', 'applying', 'applied', 'failed']),
  isOwnedByFleet: z.boolean(),
  appliedFields: z.array(z.string()),
  sealedSecretFields: z.array(z.string()),
  skippedSecretFields: z.array(z.string()),
  expectedGeneration: z.number().int().nonnegative(),
  operation: operationSchema.nullable(),
})

const errorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() })

export type AuthConfigApplyStatus = z.infer<typeof authConfigApplyStatusSchema>
export type AuthConfigApplyVariables = { projectRef?: string }
export type AuthConfigApplyError = ResponseError & { applyCode?: string }

function applyUrl(projectRef: string) {
  return `/api/platform/auth/${encodeURIComponent(projectRef)}/config/apply`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}))
}

function toError(status: number, body: unknown, fallback: string): AuthConfigApplyError {
  const parsed = errorBodySchema.safeParse(body)
  const error: AuthConfigApplyError = new ResponseError(
    (parsed.success && parsed.data.message) || fallback,
    status
  )
  if (parsed.success && parsed.data.code) error.applyCode = parsed.data.code
  return error
}

async function getAuthConfigApplyStatus(
  { projectRef }: AuthConfigApplyVariables,
  signal?: AbortSignal
): Promise<AuthConfigApplyStatus> {
  if (!projectRef) throw new Error('projectRef is required')
  const response = await fetch(applyUrl(projectRef), { headers: await constructHeaders(), signal })
  const body = await readJson(response)
  if (!response.ok) throw toError(response.status, body, 'Failed to read the Auth apply status')
  return authConfigApplyStatusSchema.parse(body)
}

export const authConfigApplyStatusQueryOptions = ({ projectRef }: AuthConfigApplyVariables) =>
  queryOptions({
    queryKey: authKeys.authConfigApply(projectRef),
    queryFn: ({ signal }) => getAuthConfigApplyStatus({ projectRef }, signal),
    enabled: STUDIO_DEPLOYMENT_PROFILE === 'fleet' && typeof projectRef !== 'undefined',
    // Poll while the Agent is applying so the result appears without a reload.
    refetchInterval: (query) => (query.state.data?.state === 'applying' ? 3000 : false),
  })

export type ApplyAuthConfigVariables = {
  projectRef: string
  expectedGeneration: number
  confirmOwnership: boolean
}

async function applyAuthConfig({
  projectRef,
  expectedGeneration,
  confirmOwnership,
}: ApplyAuthConfigVariables) {
  const response = await fetch(applyUrl(projectRef), {
    method: 'POST',
    headers: await constructHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    }),
    body: JSON.stringify({ expectedGeneration, confirmOwnership }),
  })
  const body = await readJson(response)
  if (!response.ok) throw toError(response.status, body, 'Failed to apply Auth settings')
  return body
}

export const useApplyAuthConfigMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<unknown, AuthConfigApplyError, ApplyAuthConfigVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, AuthConfigApplyError, ApplyAuthConfigVariables>({
    mutationFn: applyAuthConfig,
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: authKeys.authConfigApply(variables.projectRef),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) toast.error(`Failed to apply Auth settings: ${error.message}`)
      else onError(error, variables, context)
    },
    ...options,
  })
}
