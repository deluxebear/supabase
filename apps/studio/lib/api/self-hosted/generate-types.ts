import { DEFAULT_EXPOSED_SCHEMAS } from './constants'
import { assertSelfHosted } from './util'
import { fetchGet } from '@/data/fetchers'
import { resolveFleetPgMetaRequest } from '@/lib/api/self-platform/pg-meta'
import { PG_META_URL } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import type { ResponseError } from '@/types'

export type GenerateTypescriptTypesOptions = {
  headers?: HeadersInit
  projectRef?: string
}

type GenerateTypescriptTypesResult = {
  types: string
}

/**
 * Generates TypeScript types for the self-hosted Postgres instance via pg-meta service.
 *
 * _Only call this from server-side self-hosted code._
 */
export async function generateTypescriptTypes({
  headers,
  projectRef,
}: GenerateTypescriptTypesOptions): Promise<GenerateTypescriptTypesResult | ResponseError> {
  assertSelfHosted()

  const target =
    IS_SELF_PLATFORM && projectRef
      ? await resolveFleetPgMetaRequest(
          projectRef,
          Object.fromEntries(new Headers(headers).entries())
        )
      : { baseUrl: PG_META_URL, headers }

  // Use the schemas actually exposed via PostgREST (PGRST_DB_SCHEMAS) so generated
  // types match the Data API surface, instead of a hardcoded include/exclude list.
  // Note the param is `included_schemas` (plural) — pg-meta treats a non-empty list
  // as a strict allowlist; the singular spelling is silently ignored (includes all).
  const response = await fetchGet<GenerateTypescriptTypesResult>(
    `${target.baseUrl}/generators/typescript?included_schemas=${DEFAULT_EXPOSED_SCHEMAS}`,
    { headers: target.headers }
  )

  return response
}
