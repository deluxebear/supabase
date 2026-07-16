import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { constructHeaders } from '@/data/fetchers'
import { runtimeInventorySchema } from '@/lib/api/self-platform/runtime-inventory-contract'
import { ResponseError } from '@/types'

const keys = {
  inventory: (projectRef?: string) => ['projects', projectRef, 'runtime-inventory'] as const,
}

async function parseResponse(response: Response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const parsed = z.object({ message: z.string().optional() }).passthrough().safeParse(body)
    throw new ResponseError(
      parsed.success ? (parsed.data.message ?? 'Runtime inventory request failed') : 'Runtime inventory request failed',
      response.status
    )
  }
  return body
}

export function useRuntimeInventoryQuery(projectRef?: string) {
  return useQuery({
    queryKey: keys.inventory(projectRef),
    enabled: projectRef !== undefined,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef!)}/runtime-inventory`,
        { headers: await constructHeaders(), signal }
      )
      return z.object({ inventory: runtimeInventorySchema }).parse(await parseResponse(response))
        .inventory
    },
    staleTime: 30_000,
  })
}
