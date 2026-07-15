import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { projectKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import type { ResponseError } from '@/types'

export type ProjectCapability = {
  name: string
  state: 'available' | 'unavailable' | 'unauthorized' | 'stale' | 'unsupported'
  mode: 'direct' | 'operator' | 'agent' | 'kubernetes-job' | 'unsupported'
  source: 'static-profile' | 'preflight' | 'service-probe' | 'operator' | 'agent'
  contractVersion: string | null
  targetVersion: string | null
  observationRevision: string
  observedAt: string
  validUntil: string | null
  blockers: Array<{ code: string; message: string; remediation?: string }>
}

export type ProjectCapabilitiesVariables = { projectRef?: string }
export type ProjectCapabilitiesData = { capabilities: ProjectCapability[] }
export type ProjectCapabilitiesError = ResponseError

const projectCapabilitiesSchema = z.object({
  capabilities: z.array(
    z.object({
      name: z.string().min(1),
      state: z.enum(['available', 'unavailable', 'unauthorized', 'stale', 'unsupported']),
      mode: z.enum(['direct', 'operator', 'agent', 'kubernetes-job', 'unsupported']),
      source: z.enum(['static-profile', 'preflight', 'service-probe', 'operator', 'agent']),
      contractVersion: z.string().nullable(),
      targetVersion: z.string().nullable(),
      observationRevision: z.string().min(1),
      observedAt: z.string().datetime({ offset: true }),
      validUntil: z.string().datetime({ offset: true }).nullable(),
      blockers: z
        .array(
          z.object({
            code: z.string().min(1),
            message: z.string().min(1),
            remediation: z.string().optional(),
          })
        )
        .default([]),
    })
  ),
})

async function getProjectCapabilities(
  { projectRef }: ProjectCapabilitiesVariables,
  signal?: AbortSignal
): Promise<ProjectCapabilitiesData> {
  if (!projectRef) throw new Error('projectRef is required')
  const { data, error } = await get(
    '/platform/projects/{ref}/capabilities' as never,
    {
      params: { path: { ref: projectRef } },
      signal,
    } as never
  )
  if (error) handleError(error)
  return projectCapabilitiesSchema.parse(data) as ProjectCapabilitiesData
}

export const projectCapabilitiesQueryOptions = ({ projectRef }: ProjectCapabilitiesVariables) =>
  queryOptions({
    queryKey: [...projectKeys.detail(projectRef), 'capabilities'] as const,
    queryFn: ({ signal }) => getProjectCapabilities({ projectRef }, signal),
    enabled:
      STUDIO_DEPLOYMENT_PROFILE === 'fleet' &&
      STUDIO_CAPABILITIES.projectAttachment &&
      typeof projectRef !== 'undefined',
  })

export function findProjectCapability(
  data: ProjectCapabilitiesData | undefined,
  name: string
): ProjectCapability | undefined {
  return data?.capabilities.find((capability) => capability.name === name)
}
