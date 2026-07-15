import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { organizationKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import { managementTargetResponseSchema } from '@/data/management-trust/types'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import type { ResponseError } from '@/types'

export type ManagementTargetsVariables = { slug?: string }
export type ManagementTargetsError = ResponseError

const managementTargetsResponseSchema = z.object({
  targets: z.array(managementTargetResponseSchema),
})

async function getManagementTargets({ slug }: ManagementTargetsVariables, signal?: AbortSignal) {
  if (!slug) throw new Error('slug is required')
  const { data, error } = await get(
    '/platform/organizations/{slug}/management-targets' as never,
    { params: { path: { slug } }, signal } as never
  )
  if (error) handleError(error)
  return managementTargetsResponseSchema.parse(data)
}

export type ManagementTargetsData = Awaited<ReturnType<typeof getManagementTargets>>

export const managementTargetsQueryOptions = ({ slug }: ManagementTargetsVariables) =>
  queryOptions({
    queryKey: organizationKeys.managementTargets(slug),
    queryFn: ({ signal }) => getManagementTargets({ slug }, signal),
    enabled:
      STUDIO_DEPLOYMENT_PROFILE === 'fleet' &&
      STUDIO_CAPABILITIES.managementTrust &&
      typeof slug !== 'undefined',
  })
