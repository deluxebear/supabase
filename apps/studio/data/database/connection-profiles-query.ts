import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { databaseKeys } from './keys'
import { constructHeaders, fetchHandler } from '@/data/fetchers'
import { API_URL } from '@/lib/constants'
import { ResponseError, type UseCustomQueryOptions } from '@/types'

const connectionProfileSchema = z.object({
  id: z.enum(['direct', 'transaction', 'session', 'read_only']),
  host: z.string(),
  port: z.number().int().positive(),
  database: z.string(),
  user: z.string(),
  tlsMode: z.enum(['disable', 'prefer', 'require', 'verify-ca', 'verify-full']),
  poolMode: z.enum(['direct', 'transaction', 'session']),
})

const connectionProfilesDataSchema = z.object({
  revision: z.number().int().positive(),
  profiles: z.array(connectionProfileSchema),
})

export type ConnectionProfile = z.infer<typeof connectionProfileSchema>
export type ConnectionProfilesData = z.infer<typeof connectionProfilesDataSchema>

export async function getConnectionProfiles(projectRef: string, signal?: AbortSignal) {
  const headers = await constructHeaders()
  const response = await fetchHandler(
    `${API_URL}/platform/projects/${encodeURIComponent(projectRef)}/connection-profiles`,
    { headers, signal }
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new ResponseError(
      body.message ?? `Failed to load connection profiles (${response.status})`,
      response.status
    )
  }
  return connectionProfilesDataSchema.parse(await response.json())
}

export const useConnectionProfilesQuery = <TData = ConnectionProfilesData>(
  { projectRef }: { projectRef?: string },
  options: UseCustomQueryOptions<ConnectionProfilesData, ResponseError, TData> = {}
) =>
  useQuery<ConnectionProfilesData, ResponseError, TData>({
    queryKey: databaseKeys.connectionProfiles(projectRef),
    queryFn: ({ signal }) => getConnectionProfiles(projectRef!, signal),
    enabled: projectRef !== undefined,
    staleTime: 30_000,
    ...options,
  })
