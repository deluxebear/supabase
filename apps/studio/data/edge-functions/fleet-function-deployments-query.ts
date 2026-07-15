import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { edgeFunctionsKeys } from './keys'
import { constructHeaders } from '@/data/fetchers'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { ResponseError } from '@/types'

export const fleetFunctionDeploymentSchema = z.object({
  projectRef: z.string(),
  slug: z.string(),
  generation: z.number().int().positive(),
  desiredRevision: z.string().uuid(),
  desiredArtifactDigest: z.string().nullable(),
  activeArtifactDigest: z.string().nullable(),
  previousArtifactDigest: z.string().nullable(),
  operationId: z.string(),
  adapter: z.enum(['compose', 'kubernetes']),
  state: z.enum([
    'queued',
    'activating',
    'probing',
    'active',
    'rolled-back',
    'failed',
    'manual-intervention',
    'deleted',
  ]),
  lastErrorCode: z.string().nullable(),
  remediation: z.string().nullable(),
  observedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type FleetFunctionDeployment = z.infer<typeof fleetFunctionDeploymentSchema>
export type FleetFunctionDeploymentsVariables = { projectRef?: string }
export type FleetFunctionDeploymentsError = ResponseError

const responseSchema = z.object({ functions: z.array(fleetFunctionDeploymentSchema) })

async function getFleetFunctionDeployments(
  { projectRef }: FleetFunctionDeploymentsVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')
  const response = await fetch(
    `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef)}/functions`,
    { headers: await constructHeaders(), signal }
  )
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new ResponseError('Function deployment API returned invalid JSON', response.status)
  }
  if (!response.ok) {
    const parsed = z.object({ message: z.string().optional() }).passthrough().safeParse(body)
    throw new ResponseError(
      parsed.success
        ? (parsed.data.message ?? 'Unable to load functions')
        : 'Unable to load functions',
      response.status
    )
  }
  return responseSchema.parse(body).functions
}

export type FleetFunctionDeploymentsData = Awaited<ReturnType<typeof getFleetFunctionDeployments>>

export const fleetFunctionDeploymentsQueryOptions = ({
  projectRef,
}: FleetFunctionDeploymentsVariables) =>
  queryOptions({
    queryKey: edgeFunctionsKeys.deployments(projectRef),
    queryFn: ({ signal }) => getFleetFunctionDeployments({ projectRef }, signal),
    enabled:
      STUDIO_DEPLOYMENT_PROFILE === 'fleet' &&
      STUDIO_CAPABILITIES.remoteFunctionsDeployment &&
      projectRef !== undefined,
  })
