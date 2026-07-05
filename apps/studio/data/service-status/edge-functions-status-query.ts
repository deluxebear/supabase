import { useQuery } from '@tanstack/react-query'

import { serviceStatusKeys } from './keys'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import type { ResponseError, UseCustomQueryOptions } from '@/types'

export type EdgeFunctionServiceStatusVariables = {
  projectRef?: string
}

export async function getEdgeFunctionServiceStatus(signal?: AbortSignal) {
  try {
    const res = await fetch('https://obuldanrptloktxcffvn.supabase.co/functions/v1/health-check', {
      method: 'GET',
      signal,
    })
    const response = await res.json()
    return response as { healthy: boolean }
  } catch (err) {
    return { healthy: false }
  }
}

export type EdgeFunctionServiceStatusData = Awaited<ReturnType<typeof getEdgeFunctionServiceStatus>>
export type EdgeFunctionServiceStatusError = ResponseError

export const useEdgeFunctionServiceStatusQuery = <TData = EdgeFunctionServiceStatusData>(
  { projectRef }: EdgeFunctionServiceStatusVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<
    EdgeFunctionServiceStatusData,
    EdgeFunctionServiceStatusError,
    TData
  > = {}
) =>
  useQuery<EdgeFunctionServiceStatusData, EdgeFunctionServiceStatusError, TData>({
    queryKey: serviceStatusKeys.edgeFunctions(projectRef),
    queryFn: ({ signal }) => getEdgeFunctionServiceStatus(signal),
    // [self-platform] M6.0: the hardcoded cloud health-check URL is meaningless for attached stacks; real edge-functions probing lands with M6.2.
    enabled: enabled && !IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
    ...options,
  })
