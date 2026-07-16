import { z } from 'zod'

const nonnegativeInteger = z.number().int().nonnegative()

export const runtimeInventorySchema = z.object({
  schema: z.literal('supabase.fleet.runtime.observe.evidence.v1'),
  adapter: z.literal('compose'),
  status: z.literal('healthy'),
  observedGeneration: z.number().int().positive(),
  observedAt: z.string().datetime({ offset: true }),
  disk: z.object({
    filesystemSizeBytes: z.number().int().positive(),
    filesystemUsedBytes: nonnegativeInteger,
    filesystemAvailableBytes: nonnegativeInteger,
    databaseBytes: nonnegativeInteger,
    walBytes: nonnegativeInteger,
    systemBytes: nonnegativeInteger,
  }),
  compute: z.object({
    cpuCores: z.number().positive(),
    memoryBytes: z.number().int().positive(),
    source: z.string().min(1),
  }),
  containers: z.array(
    z.object({
      service: z.string().min(1),
      name: z.string().min(1),
      image: z.string().min(1),
      imageId: z.string().min(1),
      state: z.string().min(1),
      health: z.string().min(1),
      cpuCores: z.number().nonnegative(),
      memoryBytes: nonnegativeInteger,
    })
  ),
  volumes: z.array(
    z.object({ name: z.string().min(1), driver: z.string().min(1), usedBytes: nonnegativeInteger })
  ),
  versions: z.array(
    z.object({
      service: z.string().min(1),
      version: z.string().min(1),
      image: z.string().min(1),
      state: z.string().min(1),
      health: z.string().min(1),
    })
  ),
  upgrade: z.object({
    currentPostgresVersion: z.string().min(1),
    currentImage: z.string().min(1),
    latestSupportedVersion: z.string().min(1),
    targetVersions: z.array(z.string()),
    eligible: z.boolean(),
    checks: z.array(
      z.object({
        code: z.string(),
        state: z.enum(['passed', 'failed', 'blocked']),
        message: z.string(),
      })
    ),
    blockers: z.array(
      z.object({ code: z.string(), message: z.string(), remediation: z.string() })
    ),
    plan: z.array(z.string()).min(1),
    rollback: z.array(z.string()).min(1),
    recovery: z.array(z.string()).min(1),
    progress: z.string().min(1),
  }),
})

export type RuntimeInventory = z.infer<typeof runtimeInventorySchema>
