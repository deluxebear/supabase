import {
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { secretsKeys } from './keys'
import { constructHeaders } from '@/data/fetchers'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'
import { ResponseError } from '@/types'

// [self-platform] Whether stored Edge Function secrets reach the project's
// Edge Functions runtime, and applying them. Fleet profile only.

const operationSchema = z.object({
  id: z.string(),
  state: z.string(),
  errorCode: z.string().nullable(),
  updatedAt: z.string(),
})

const functionSecretsApplyStatusSchema = z.object({
  availability: z.discriminatedUnion('isAvailable', [
    z.object({ isAvailable: z.literal(true) }),
    z.object({ isAvailable: z.literal(false), code: z.string(), message: z.string() }),
  ]),
  state: z.enum(['nothing-to-apply', 'pending', 'applying', 'applied', 'failed']),
  isOwnedByFleet: z.boolean(),
  sealedSecretNames: z.array(z.string()),
  skippedSecretNames: z.array(z.string()),
  reservedSecretNames: z.array(z.string()),
  expectedGeneration: z.number().int().nonnegative(),
  operation: operationSchema.nullable(),
})

const errorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() })

export type FunctionSecretsApplyStatus = z.infer<typeof functionSecretsApplyStatusSchema>
export type FunctionSecretsApplyVariables = { projectRef?: string }
export type FunctionSecretsApplyError = ResponseError & { applyCode?: string }

const isFunctionSecretsApplyEnabled = () =>
  STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.remoteFunctionsDeployment

function applyUrl(projectRef: string) {
  return `/api/platform/projects/${encodeURIComponent(projectRef)}/functions/secrets/apply`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}))
}

function toError(status: number, body: unknown, fallback: string): FunctionSecretsApplyError {
  const parsed = errorBodySchema.safeParse(body)
  const error: FunctionSecretsApplyError = new ResponseError(
    (parsed.success && parsed.data.message) || fallback,
    status
  )
  if (parsed.success && parsed.data.code) error.applyCode = parsed.data.code
  return error
}

async function getFunctionSecretsApplyStatus(
  { projectRef }: FunctionSecretsApplyVariables,
  signal?: AbortSignal
): Promise<FunctionSecretsApplyStatus> {
  if (!projectRef) throw new Error('projectRef is required')
  const response = await fetch(applyUrl(projectRef), { headers: await constructHeaders(), signal })
  const body = await readJson(response)
  if (!response.ok) {
    throw toError(response.status, body, 'Failed to read the Edge Function secrets apply status')
  }
  return functionSecretsApplyStatusSchema.parse(body)
}

export const functionSecretsApplyStatusQueryOptions = ({
  projectRef,
}: FunctionSecretsApplyVariables) =>
  queryOptions({
    queryKey: secretsKeys.applyStatus(projectRef),
    queryFn: ({ signal }) => getFunctionSecretsApplyStatus({ projectRef }, signal),
    enabled: isFunctionSecretsApplyEnabled() && typeof projectRef !== 'undefined',
    // Poll while the Agent is applying so the result appears without a reload.
    refetchInterval: (query) => (query.state.data?.state === 'applying' ? 3000 : false),
  })

export type ApplyFunctionSecretsVariables = {
  projectRef: string
  expectedGeneration: number
  confirmOwnership: boolean
}

async function applyFunctionSecrets({
  projectRef,
  expectedGeneration,
  confirmOwnership,
}: ApplyFunctionSecretsVariables) {
  const response = await fetch(applyUrl(projectRef), {
    method: 'POST',
    headers: await constructHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': uuidv4(),
    }),
    body: JSON.stringify({ expectedGeneration, confirmOwnership }),
  })
  const body = await readJson(response)
  if (!response.ok) throw toError(response.status, body, 'Failed to apply Edge Function secrets')
  return body
}

export const useApplyFunctionSecretsMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<unknown, FunctionSecretsApplyError, ApplyFunctionSecretsVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, FunctionSecretsApplyError, ApplyFunctionSecretsVariables>({
    mutationFn: applyFunctionSecrets,
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: secretsKeys.applyStatus(variables.projectRef),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) {
        toast.error(
          $t('Failed to apply Edge Function secrets: {{value0}}', { value0: error.message })
        )
      } else onError(error, variables, context)
    },
    ...options,
  })
}
