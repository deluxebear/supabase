// [self-platform] Phase 2: Storage settings. Only the settings the Storage
// service reads from its environment are applied: the global upload size limit
// and image transformation. Other feature flags stay read-only.
import { z } from 'zod'

// 50 GiB, the largest limit the Storage service accepts.
export const MAX_FILE_SIZE_LIMIT = 53_687_091_200

export const storageUpdateSchema = z
  .object({
    fileSizeLimit: z.number().int().min(0).max(MAX_FILE_SIZE_LIMIT),
    features: z
      .object({
        imageTransformation: z.object({ enabled: z.boolean() }).passthrough(),
      })
      .partial()
      .passthrough(),
  })
  .partial()
  .passthrough()

export type StoredStorageOverrides = {
  fileSizeLimit?: number
  imageTransformationEnabled?: boolean
}

const storedSchema = z
  .object({
    fileSizeLimit: z.number().int().min(0).max(MAX_FILE_SIZE_LIMIT),
    imageTransformationEnabled: z.boolean(),
  })
  .partial()

/** Extracts the settings Fleet can apply from a Studio update body. */
export function toStoredStorageOverrides(
  body: z.infer<typeof storageUpdateSchema>
): StoredStorageOverrides {
  const overrides: StoredStorageOverrides = {}
  if (body.fileSizeLimit !== undefined) overrides.fileSizeLimit = body.fileSizeLimit
  const imageTransformation = body.features?.imageTransformation
  if (imageTransformation !== undefined) {
    overrides.imageTransformationEnabled = imageTransformation.enabled
  }
  return overrides
}

export function parseStoredStorageOverrides(
  stored: Record<string, unknown>
): StoredStorageOverrides {
  const parsed = storedSchema.safeParse(stored)
  return parsed.success ? parsed.data : {}
}

const ENV_NAMES = {
  fileSizeLimit: 'FILE_SIZE_LIMIT',
  imageTransformationEnabled: 'ENABLE_IMAGE_TRANSFORMATION',
} as const

export function renderStorageEnv(stored: Record<string, unknown>): Record<string, string> {
  const overrides = parseStoredStorageOverrides(stored)
  const env: Record<string, string> = {}
  for (const [field, name] of Object.entries(ENV_NAMES)) {
    const value = overrides[field as keyof StoredStorageOverrides]
    if (value === undefined) continue
    env[name] = String(value)
  }
  return env
}

export function storageAppliedFields(stored: Record<string, unknown>): string[] {
  const env = renderStorageEnv(stored)
  return Object.entries(ENV_NAMES)
    .filter(([, name]) => env[name] !== undefined)
    .map(([field]) => field)
    .sort()
}
