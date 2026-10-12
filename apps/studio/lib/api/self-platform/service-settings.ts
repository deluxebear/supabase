// [self-platform] Phase 2: stored overrides for services that read their
// configuration from the environment at boot (PostgREST, Storage). The store
// holds only the operator's explicit overrides; everything else keeps coming
// from the base Compose environment. Settings are desired state until applied
// through Fleet (env-service-apply.ts).
import { z } from 'zod'

import { executePlatformQuery } from './db'

export type StoredServiceName = 'postgrest' | 'storage'

const storedRowSchema = z.object({ config: z.record(z.string(), z.unknown()) })

export async function readStoredServiceConfig(
  projectRef: string,
  service: StoredServiceName
): Promise<Record<string, unknown>> {
  const result = await executePlatformQuery({
    query: 'select config from platform.service_config where project_ref = $1 and service = $2',
    parameters: [projectRef, service],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  return row === undefined ? {} : storedRowSchema.parse(row).config
}

/**
 * Merges `patch` over the stored overrides and returns the result. A `null`
 * value clears that override. Overrides are flat, so stripping nulls is safe.
 */
export async function mergeStoredServiceConfig(input: {
  projectRef: string
  service: StoredServiceName
  patch: Record<string, unknown>
  actor: string
}): Promise<Record<string, unknown>> {
  const result = await executePlatformQuery({
    query: `insert into platform.service_config (project_ref, service, config, updated_by)
      values ($1, $2, jsonb_strip_nulls($3::jsonb), $4)
      on conflict (project_ref, service) do update set
        config = jsonb_strip_nulls(platform.service_config.config || excluded.config),
        updated_at = now(),
        updated_by = excluded.updated_by
      returning config`,
    parameters: [input.projectRef, input.service, JSON.stringify(input.patch), input.actor],
  })
  if (result.error) throw result.error
  return storedRowSchema.parse(result.data?.[0]).config
}
