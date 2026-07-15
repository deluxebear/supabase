import { z } from 'zod'

export const lifecycleActions = [
  'runtime.restart',
  'runtime.rollout',
  'runtime.scale',
  'postgres.upgrade.plan',
  'postgres.upgrade.execute',
  'replica.create',
  'replica.remove',
  'branch.create',
  'branch.restore',
  'network.bans.read',
  'network.bans.update',
] as const
export type LifecycleAction = (typeof lifecycleActions)[number]
export interface LifecycleParameters {
  service?: string
  replicas?: number
  targetVersion?: string
  replicaName?: string
  branchName?: string
  sourceBranch?: string
  bannedNetworks?: string[]
}
export interface LifecycleComponentVersions {
  postgres: string
  gotrue: string
  postgrest: string
  storage: string
  realtime: string
  edgeRuntime: string
  gateway: string
  adapter: string
  fleetControl: string
  backupOperator: string
  agent: string
}
export interface LifecyclePlanInput {
  action: LifecycleAction
  parameters: LifecycleParameters
}
export const lifecycleActionSchema = z.enum(lifecycleActions)
export const lifecycleComponentVersionsSchema = z
  .object({
    postgres: z.string().min(1).max(128),
    gotrue: z.string().min(1).max(128),
    postgrest: z.string().min(1).max(128),
    storage: z.string().min(1).max(128),
    realtime: z.string().min(1).max(128),
    edgeRuntime: z.string().min(1).max(128),
    gateway: z.string().min(1).max(128),
    adapter: z.string().min(1).max(128),
    fleetControl: z.string().min(1).max(128),
    backupOperator: z.string().min(1).max(128),
    agent: z.string().min(1).max(128),
  })
  .strict()
export const lifecycleParametersSchema = z
  .object({
    service: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
    replicas: z.number().int().min(0).max(64).optional(),
    targetVersion: z.string().min(1).max(32).optional(),
    replicaName: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
    branchName: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
    sourceBranch: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
    bannedNetworks: z.array(z.string().min(3).max(64)).max(256).optional(),
  })
  .strict()
export const lifecyclePlanInputSchema: z.ZodType<LifecyclePlanInput> = z
  .object({ action: lifecycleActionSchema, parameters: lifecycleParametersSchema })
  .strict()
export interface LifecycleImpactPlan {
  schema: 'supabase.fleet.lifecycle.impact-plan.v1'
  id: string
  projectRef: string
  action: LifecycleAction
  adapter: 'compose' | 'kubernetes'
  parameters: LifecycleParameters
  componentVersions: LifecycleComponentVersions
  impact: {
    serviceInterruption: boolean
    writeUnavailability: boolean
    dataLossRisk: string
    affectedServices: string[]
    estimatedSeconds: number
  }
  verification: string[]
  rollback: string[]
  manualIntervention: string[]
  requiresRecentAal2: boolean
  requiresExplicitConfirmation: boolean
  createdAt: string
  expiresAt: string
  hash: string
}
export const lifecycleImpactPlanSchema: z.ZodType<LifecycleImpactPlan> = z
  .object({
    schema: z.literal('supabase.fleet.lifecycle.impact-plan.v1'),
    id: z.string(),
    projectRef: z.string(),
    action: lifecycleActionSchema,
    adapter: z.enum(['compose', 'kubernetes']),
    parameters: lifecycleParametersSchema,
    componentVersions: lifecycleComponentVersionsSchema,
    impact: z.object({
      serviceInterruption: z.boolean(),
      writeUnavailability: z.boolean(),
      dataLossRisk: z.string(),
      affectedServices: z.array(z.string()),
      estimatedSeconds: z.number().int(),
    }),
    verification: z.array(z.string()),
    rollback: z.array(z.string()),
    manualIntervention: z.array(z.string()),
    requiresRecentAal2: z.boolean(),
    requiresExplicitConfirmation: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
export interface LifecycleExecuteInput {
  plan: LifecycleImpactPlan
  expectedGeneration: number
  idempotencyKey: string
}
export const lifecycleExecuteInputSchema: z.ZodType<LifecycleExecuteInput> = z
  .object({
    plan: lifecycleImpactPlanSchema,
    expectedGeneration: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(255),
  })
  .strict()
