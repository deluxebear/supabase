import { z } from 'zod'

const nullableStringArraySchema = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? [])

export const backupPolicySchema = z.object({
  id: z.string().optional(),
  enabled: z.boolean(),
  repositoryId: z.string().default(''),
  retentionDays: z.number().int().positive(),
  fullSchedule: z.string(),
  diffSchedule: z.string().nullable(),
  incrSchedule: z.string().nullable(),
  backupFrom: z.enum(['primary', 'standby']),
  designatedStandby: z.string().nullable(),
  maxStandbyLagBytes: z.number().int().nonnegative().default(0),
  nextRunAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable(),
})

export const operatorClusterSchema = z.object({
  projectId: z.string(),
  targetId: z.string(),
  systemIdentifier: z.string(),
  dataDomain: z.string(),
  createdAt: z.string().nullable().optional(),
  discovery: z
    .object({
      provider: z.string(),
      providerVersion: z.string().optional(),
      topology: z.string(),
      primary: z.string().optional(),
      standbys: nullableStringArraySchema,
      repositoryId: z.string().optional(),
      repositoryType: z.string().optional(),
      repositoryLocation: z.string().optional(),
      blockers: nullableStringArraySchema,
      observedAt: z.string(),
    })
    .nullable(),
})

export const operatorPITRSchema = z.object({
  enabled: z.boolean(),
  healthy: z.boolean(),
  archiveCommand: z.string().optional(),
  repositoryId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  blockers: nullableStringArraySchema,
})

export const operatorBackupSchema = z.object({
  id: z.string(),
  type: z.enum(['full', 'diff', 'incr']),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  recoverableUntil: z.string().nullable(),
})

export const operatorBackupsSchema = z.object({
  backups: z.array(operatorBackupSchema),
  recoveryWindow: z.object({ earliest: z.string().nullable(), latest: z.string().nullable() }),
  confidence: z.enum(['unknown', 'inferred', 'drill-verified']),
  isStale: z.boolean(),
  blockers: nullableStringArraySchema,
  drill: z
    .object({
      id: z.string(),
      targetTime: z.string(),
      completedAt: z.string(),
      passed: z.boolean(),
      evidenceDigest: z.string().nullable(),
    })
    .nullable(),
})

export const restorePlanSchema = z.object({
  id: z.string(),
  hash: z.string(),
  expiresAt: z.string(),
  recoveryTarget: z.string(),
  impact: z.object({
    serviceInterruption: z.string(),
    affectedNodes: z.array(z.string()),
    requiredBytes: z.number().nonnegative(),
  }),
  blockers: z.array(z.string()),
})

export const operatorJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  state: z.enum([
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'orphaned',
    'manual-intervention',
    'rollback-available',
  ]),
  progress: z.number().min(0).max(100).default(0),
  updatedAt: z.string(),
  rollbackUntil: z.string().nullable().default(null),
  manualIntervention: z
    .object({
      code: z.string(),
      summary: z.string(),
      safeAction: z.string(),
      runbookUrl: z.string(),
    })
    .nullable()
    .default(null),
})
