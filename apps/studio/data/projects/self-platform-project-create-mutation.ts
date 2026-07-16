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
  dbPassReadonly?: string
  kongUrl: string
  restUrl?: string
  anonKey?: string
  serviceKey?: string
  jwtSecret?: string
  publishableKey?: string
  secretKey?: string
  keyMode: 'legacy-jwt' | 'asymmetric-jwks' | 'mixed'
  tlsMode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
  tlsCaReference?: string
  logflareUrl?: string
  logflareToken?: string
}

export type SelfPlatformPublicEndpoints = {
  apiUrl: string
  restUrl: string
  authUrl: string
  storageUrl: string
  realtimeUrl: string
  functionsUrl: string
  s3Url: string
  directPostgres: {
    host: string
    port: number
    database: string
    user: string
    tlsMode: SelfPlatformExternalConnection['tlsMode']
  }
  supavisor: {
    host: string
    transactionPort: number
    sessionPort: number
    database: string
    user: string
    tenantId: string
    tlsMode: SelfPlatformExternalConnection['tlsMode']
  }
}

export type SelfPlatformProjectCreateVariables =
  | { mode: 'shared-db'; organizationSlug: string; name: string; ref: string; hostRef: string }
  | {
      mode: 'external'
      organizationSlug: string
      name: string
      ref: string
      connection: SelfPlatformExternalConnection
      attachmentMode?: 'active' | 'staged'
      publicEndpoints?: SelfPlatformPublicEndpoints
    }

export type SelfPlatformProjectCreateResponse = {
  id: number
  ref: string
  name: string
  status: string
  organization_slug: string
  attachment_state: 'active' | 'validating'
  connection_revision: number
  preflight?: {
    outcome: 'pass' | 'fail'
    stackFingerprint: string | null
    checks: Array<{
      name: string
      status: 'pass' | 'fail' | 'warning' | 'unsupported'
      required: boolean
      message: string
      remediation?: string
    }>
  }
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
          attachment_mode: vars.attachmentMode,
          public_endpoints: vars.publicEndpoints,
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
