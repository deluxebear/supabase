// [self-platform] Phase 2: PostgREST settings. Stored as the operator's
// explicit overrides and rendered into PGRST_* variables of the `rest` service.
import { z } from 'zod'

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

const schemaList = (min: number) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )
    .refine((items) => items.length >= min, 'At least one schema is required')
    .refine((items) => items.every((item) => SCHEMA_NAME.test(item)), 'Invalid schema name')
    .transform((items) => items.join(','))

// Keys are the PostgREST config contract's field names.
export const postgrestUpdateSchema = z
  .object({
    db_schema: schemaList(1),
    db_extra_search_path: schemaList(0),
    max_rows: z.number().int().min(1).max(1_000_000),
    db_pool: z.number().int().min(1).max(1000).nullish(),
  })
  .partial()
  .strict()

export type PostgrestOverrides = z.infer<typeof postgrestUpdateSchema>

const ENV_NAMES = {
  db_schema: 'PGRST_DB_SCHEMAS',
  db_extra_search_path: 'PGRST_DB_EXTRA_SEARCH_PATH',
  max_rows: 'PGRST_DB_MAX_ROWS',
  db_pool: 'PGRST_DB_POOL',
} as const

/** Renders only the stored overrides; unset fields stay with the base Compose environment. */
export function renderPostgrestEnv(stored: Record<string, unknown>): Record<string, string> {
  const parsed = postgrestUpdateSchema.safeParse(stored)
  if (!parsed.success) return {}
  const env: Record<string, string> = {}
  for (const [field, name] of Object.entries(ENV_NAMES)) {
    const value = parsed.data[field as keyof PostgrestOverrides]
    if (value === undefined || value === null) continue
    env[name] = String(value)
  }
  return env
}

/** Names of the stored fields that the render applies, sorted. */
export function postgrestAppliedFields(stored: Record<string, unknown>): string[] {
  const env = renderPostgrestEnv(stored)
  return Object.entries(ENV_NAMES)
    .filter(([, name]) => env[name] !== undefined)
    .map(([field]) => field)
    .sort()
}
