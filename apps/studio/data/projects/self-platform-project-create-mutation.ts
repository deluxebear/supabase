import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { useInvalidateProjectsInfiniteQuery } from './org-projects-infinite-query'
import type { components } from '@/data/api'
import { handleError, post } from '@/data/fetchers'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type SelfPlatformExternalConnection = {
  dbHost: string
  dbPort?: number
  dbName?: string
  dbUser?: string
  dbUserReadonly?: string
  dbPass: string
  kongUrl: string
  restUrl?: string
  anonKey: string
  serviceKey: string
  jwtSecret: string
  publishableKey?: string
  secretKey?: string
  logflareUrl?: string
  logflareToken?: string
}

export type SelfPlatformProjectCreateVariables =
  | { mode: 'shared-db'; organizationSlug: string; name: string; ref: string; hostRef: string }
  | {
      mode: 'external'
      organizationSlug: string
      name: string
      ref: string
      connection: SelfPlatformExternalConnection
    }

export type SelfPlatformProjectCreateResponse = {
  id: number
  ref: string
  name: string
  status: string
  organization_slug: string
}

export async function createSelfPlatformProject(vars: SelfPlatformProjectCreateVariables) {
  const body =
    vars.mode === 'shared-db'
      ? {
          mode: 'shared-db',
          organization_slug: vars.organizationSlug,
          name: vars.name,
          ref: vars.ref,
          host_ref: vars.hostRef,
        }
      : {
          mode: 'external',
          organization_slug: vars.organizationSlug,
          name: vars.name,
          ref: vars.ref,
          connection: vars.connection,
        }
  // [self-platform] The body intentionally diverges from the cloud
  // CreateProjectBody (spec §4); the openapi client is typed to the cloud
  // contract, hence the cast (M1 precedent: self-platform shapes diverge).
  const { data, error } = await post('/platform/projects', {
    body: body as unknown as components['schemas']['CreateProjectBody'],
  })
  if (error) handleError(error)
  return data as unknown as SelfPlatformProjectCreateResponse
}

export const useSelfPlatformProjectCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<
    SelfPlatformProjectCreateResponse,
    ResponseError,
    SelfPlatformProjectCreateVariables
  >,
  'mutationFn'
> = {}) => {
  const { invalidateProjectsQuery } = useInvalidateProjectsInfiniteQuery()
  return useMutation<
    SelfPlatformProjectCreateResponse,
    ResponseError,
    SelfPlatformProjectCreateVariables
  >({
    mutationFn: (vars) => createSelfPlatformProject(vars),
    async onSuccess(data, variables, context) {
      await invalidateProjectsQuery()
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to create new project: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
