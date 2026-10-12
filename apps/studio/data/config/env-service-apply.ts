// [self-platform] Applies stored PostgREST or Storage settings to the
// Fleet-managed service, and reads whether the running service uses them.
import {
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { configKeys } from './keys'
import { constructHeaders } from '@/data/fetchers'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'
import { ResponseError } from '@/types'

export type EnvApplyService = 'postgrest' | 'storage'

const statusSchema = z.object({
  availability: z.discriminatedUnion('isAvailable', [
    z.object({ isAvailable: z.literal(true) }),
    z.object({ isAvailable: z.literal(false), code: z.string(), message: z.string() }),
  ]),
  state: z.enum(['nothing-to-apply', 'pending', 'applying', 'applied', 'failed']),
  isOwnedByFleet: z.boolean(),
  appliedFields: z.array(z.string()),
  expectedGeneration: z.number().int().nonnegative(),
  operation: z
    .object({
      id: z.string(),
      state: z.string(),
      errorCode: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
})

const errorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() })

export type EnvServiceApplyStatus = z.infer<typeof statusSchema>
export type EnvServiceApplyError = ResponseError & { applyCode?: string }

function applyUrl(projectRef: string, service: EnvApplyService) {
  return `/api/platform/projects/${encodeURIComponent(projectRef)}/config/${service}/apply`
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}))
}

function toError(status: number, body: unknown, fallback: string): EnvServiceApplyError {
  const parsed = errorBodySchema.safeParse(body)
  const error: EnvServiceApplyError = new ResponseError(
    (parsed.success && parsed.data.message) || fallback,
    status
  )
  if (parsed.success && parsed.data.code) error.applyCode = parsed.data.code
  return error
}

async function getStatus(
  projectRef: string,
  service: EnvApplyService,
  signal?: AbortSignal
): Promise<EnvServiceApplyStatus> {
  const response = await fetch(applyUrl(projectRef, service), {
    headers: await constructHeaders(),
    signal,
  })
  const body = await readJson(response)
  if (!response.ok) throw toError(response.status, body, 'Failed to read the apply status')
  return statusSchema.parse(body)
}

export const envServiceApplyStatusQueryOptions = ({
  projectRef,
  service,
}: {
  projectRef?: string
  service: EnvApplyService
}) =>
  queryOptions({
    queryKey: configKeys.envServiceApply(projectRef, service),
    queryFn: ({ signal }) => getStatus(projectRef as string, service, signal),
    enabled: STUDIO_DEPLOYMENT_PROFILE === 'fleet' && typeof projectRef !== 'undefined',
    // Poll while the Agent is applying so the result appears without a reload.
    refetchInterval: (query) => (query.state.data?.state === 'applying' ? 3000 : false),
  })

export type ApplyEnvServiceVariables = {
  projectRef: string
  service: EnvApplyService
  expectedGeneration: number
  confirmOwnership: boolean
}

async function applyEnvService({
  projectRef,
  service,
  expectedGeneration,
  confirmOwnership,
}: ApplyEnvServiceVariables) {
  const response = await fetch(applyUrl(projectRef, service), {
    method: 'POST',
    headers: await constructHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': uuidv4(),
    }),
    body: JSON.stringify({ expectedGeneration, confirmOwnership }),
  })
  const body = await readJson(response)
  if (!response.ok) throw toError(response.status, body, 'Failed to apply the settings')
  return body
}

export const useApplyEnvServiceMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<unknown, EnvServiceApplyError, ApplyEnvServiceVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, EnvServiceApplyError, ApplyEnvServiceVariables>({
    mutationFn: applyEnvService,
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: configKeys.envServiceApply(variables.projectRef, variables.service),
      })
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined)
        toast.error($t('Failed to apply settings: {{value0}}', { value0: error.message }))
      else onError(error, variables, context)
    },
    ...options,
  })
}
