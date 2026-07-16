import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { projectKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import { managementBindingResponseSchema } from '@/data/management-trust/types'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import type { ResponseError } from '@/types'

export type ProjectManagementBindingVariables = { projectRef?: string }
export type ProjectManagementBindingError = ResponseError

const projectManagementBindingResponseSchema = z.object({
  binding: managementBindingResponseSchema.nullable(),
})

async function getProjectManagementBinding(
  { projectRef }: ProjectManagementBindingVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')
  const { data, error } = await get(
    '/platform/projects/{ref}/management-binding' as never,
    { params: { path: { ref: projectRef } }, signal } as never
  )
  if (error) handleError(error)
  return projectManagementBindingResponseSchema.parse(data)
}

export type ProjectManagementBindingData = Awaited<ReturnType<typeof getProjectManagementBinding>>

export const projectManagementBindingQueryOptions = ({
  projectRef,
}: ProjectManagementBindingVariables) =>
  queryOptions({
    queryKey: projectKeys.managementBinding(projectRef),
    queryFn: ({ signal }) => getProjectManagementBinding({ projectRef }, signal),
    enabled:
      STUDIO_DEPLOYMENT_PROFILE === 'fleet' &&
      STUDIO_CAPABILITIES.managementTrust &&
      typeof projectRef !== 'undefined',
    refetchInterval: 10_000,
  })
