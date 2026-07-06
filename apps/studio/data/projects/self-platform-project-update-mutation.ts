import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { projectKeys } from './keys'
import { useInvalidateProjectsInfiniteQuery } from './org-projects-infinite-query'
import { handleError, patch } from '@/data/fetchers'
import { serviceStatusKeys } from '@/data/service-status/keys'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type SelfPlatformConnectionPatch = {
  dbHost?: string
  dbPort?: number
  dbName?: string
  dbUser?: string
  dbUserReadonly?: string
  dbPass?: string
  kongUrl?: string
  restUrl?: string
  anonKey?: string
  serviceKey?: string
  jwtSecret?: string
  publishableKey?: string | null
  secretKey?: string | null
}

export type SelfPlatformProjectUpdateVariables = {
  ref: string
  name?: string
  connection?: SelfPlatformConnectionPatch
  logflare?: { url?: string | null; token?: string | null }
  metrics?: { url?: string | null; token?: string | null }
  container?: string | null
}

export type SelfPlatformProjectUpdateResponse = {
  id: number
  ref: string
  name: string
  status: string
  propagated_children: string[]
}

// [self-platform] GET /platform/projects/{ref} additive prefill block (M6.1
// spec §5) — the openapi client is typed to the cloud contract, so consumers
// read it via a cast (M5.0 stack_kind compat precedent).
export type SelfPlatformProjectBlock = {
  stack_kind: string
  host_ref: string | null
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_user_readonly: string
  kong_url: string
  rest_url: string
  logflare_url: string | null
  metrics_url: string | null
  container_name: string | null
  secrets_set: {
    db_pass: boolean
    anon_key: boolean
    service_key: boolean
    jwt_secret: boolean
    publishable_key: boolean
    secret_key: boolean
    logflare_token: boolean
    metrics_token: boolean
  }
  shared_children: string[]
}

export async function updateSelfPlatformProject({
  ref,
  ...body
}: SelfPlatformProjectUpdateVariables) {
  // [self-platform] The body intentionally diverges from the cloud update
  // contract (spec §3); the openapi client is typed to the cloud shape,
  // hence the cast (M5.0 create-mutation precedent).
  const { data, error } = await patch('/platform/projects/{ref}', {
    params: { path: { ref } },
    body: body as unknown as { name: string },
  })
  if (error) handleError(error)
  return data as unknown as SelfPlatformProjectUpdateResponse
}

export const useSelfPlatformProjectUpdateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<
    SelfPlatformProjectUpdateResponse,
    ResponseError,
    SelfPlatformProjectUpdateVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  const { invalidateProjectsQuery } = useInvalidateProjectsInfiniteQuery()
  return useMutation<
    SelfPlatformProjectUpdateResponse,
    ResponseError,
    SelfPlatformProjectUpdateVariables
  >({
    mutationFn: (vars) => updateSelfPlatformProject(vars),
    async onSuccess(data, variables, context) {
      const { ref } = variables
      await Promise.all([
        invalidateProjectsQuery(),
        queryClient.invalidateQueries({ queryKey: projectKeys.detail(ref) }),
        queryClient.invalidateQueries({ queryKey: serviceStatusKeys.serviceStatus(ref) }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to update project: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
