import { useQuery } from '@tanstack/react-query'
import { components } from 'api-types'

import { serviceStatusKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import type { ResponseError, UseCustomQueryOptions } from '@/types'

// [self-platform] M6.2: edge_function is probed by the self-platform engine.
// Upstream api-types' service-name enum has no 'edge_function' literal —
// cast, same type-lag class as the DISABLED widening in ServiceStatus.tsx.
const REQUESTED_SERVICES = (
  IS_SELF_PLATFORM
    ? ['auth', 'realtime', 'rest', 'storage', 'db', 'edge_function']
    : ['auth', 'realtime', 'rest', 'storage', 'db']
) as ('auth' | 'realtime' | 'rest' | 'storage' | 'db')[]

export type ProjectServiceStatusVariables = {
  projectRef?: string
}

// Omit the 'healthy' field as it's equivalent to status = 'ACTIVE_HEALTHY'
export type ServiceHealthResponse = Omit<
  components['schemas']['V1ServiceHealthResponse'],
  'healthy'
>
export type ProjectServiceStatus = ServiceHealthResponse['status']

export async function getProjectServiceStatus(
  { projectRef }: ProjectServiceStatusVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')

  const { data, error } = await get(`/v1/projects/{ref}/health`, {
    params: {
      path: { ref: projectRef },
      query: {
        services: REQUESTED_SERVICES,
      },
    },
    signal,
  })

  if (error) handleError(error)

  return data as ServiceHealthResponse[]
}

export type ProjectServiceStatusData = Awaited<ReturnType<typeof getProjectServiceStatus>>
export type ProjectServiceStatusError = ResponseError

export const useProjectServiceStatusQuery = <TData = ProjectServiceStatusData>(
  { projectRef }: ProjectServiceStatusVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<ProjectServiceStatusData, ProjectServiceStatusError, TData> = {}
) =>
  useQuery<ProjectServiceStatusData, ProjectServiceStatusError, TData>({
    queryKey: serviceStatusKeys.serviceStatus(projectRef),
    queryFn: ({ signal }) => getProjectServiceStatus({ projectRef }, signal),
    enabled: enabled && typeof projectRef !== 'undefined',
    ...options,
  })
