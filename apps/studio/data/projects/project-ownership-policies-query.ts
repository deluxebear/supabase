import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { projectKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import { ownershipPolicySchema } from '@/lib/api/self-platform/ownership-policy.shared'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

const responseSchema = z.object({ policies: z.array(ownershipPolicySchema) })

async function getProjectOwnershipPolicies(projectRef: string | undefined, signal?: AbortSignal) {
  if (!projectRef) throw new Error('projectRef is required')
  const { data, error } = await get(
    '/platform/projects/{ref}/ownership-policies' as never,
    { params: { path: { ref: projectRef } }, signal } as never
  )
  if (error) handleError(error)
  return responseSchema.parse(data)
}

export const projectOwnershipPoliciesQueryOptions = ({ projectRef }: { projectRef?: string }) =>
  queryOptions({
    queryKey: projectKeys.ownershipPolicies(projectRef),
    queryFn: ({ signal }) => getProjectOwnershipPolicies(projectRef, signal),
    enabled:
      STUDIO_DEPLOYMENT_PROFILE === 'fleet' &&
      STUDIO_CAPABILITIES.ownershipReconciliation &&
      projectRef !== undefined,
  })
