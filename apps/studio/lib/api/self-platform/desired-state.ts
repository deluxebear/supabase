// [self-platform] T5 authority boundary. These functions are server-only and
// intentionally do not resolve management bindings: T7 supplies a verified
// project binding after Profile, capability, and RBAC checks. Browser routes
// must never pass targetId/bindingId through from user input.
import { z } from 'zod'

import { executePlatformQuery } from './db'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

const jsonValueSchema = z.custom<JsonValue>(isJsonValue, 'Expected a JSON value')

export const commitDesiredConfigurationSchema = z.object({
  projectRef: z.string().min(1).max(128),
  domain: z.string().min(1).max(64),
  capability: z.string().min(1).max(128),
  expectedGeneration: z.number().int().nonnegative(),
  operationId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128),
  bindingId: z.string().min(1).max(128),
  inputSchema: z.string().startsWith('supabase.fleet.'),
  idempotencyKey: z.string().min(1).max(255),
  desiredDocument: jsonValueSchema,
  preconditions: z.record(z.string(), jsonValueSchema).default({}),
  actor: z.string().min(1).max(255),
  correlationId: z.string().min(1).max(128),
})

const committedRowSchema = z.object({
  operation_id: z.string(),
  revision_id: z.string().uuid(),
  generation: z.coerce.number().int().positive(),
  desired_digest: z.string().regex(/^[0-9a-f]{64}$/),
  replayed: z.boolean(),
})

export type CommitDesiredConfigurationInput = z.infer<typeof commitDesiredConfigurationSchema>
export type CommittedDesiredConfiguration = {
  operationId: string
  revisionId: string
  generation: number
  desiredDigest: string
  isReplayed: boolean
}

export class ConfigurationConflictError extends Error {
  readonly code = 'configuration_conflict'

  constructor() {
    super('The desired configuration changed; reload it before saving again')
    this.name = 'ConfigurationConflictError'
  }
}

export async function commitDesiredConfiguration(
  value: CommitDesiredConfigurationInput
): Promise<CommittedDesiredConfiguration> {
  const input = commitDesiredConfigurationSchema.parse(value)
  const result = await executePlatformQuery({
    query: `select * from platform.commit_desired_configuration(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13
    )`,
    parameters: [
      input.projectRef,
      input.domain,
      input.capability,
      input.expectedGeneration,
      input.operationId,
      input.targetId,
      input.bindingId,
      input.inputSchema,
      input.idempotencyKey,
      JSON.stringify(input.desiredDocument),
      JSON.stringify(input.preconditions),
      input.actor,
      input.correlationId,
    ],
  })
  if (result.error) {
    if (result.error.message.includes('configuration_conflict')) {
      throw new ConfigurationConflictError()
    }
    throw result.error
  }
  const row = committedRowSchema.parse(result.data?.[0])
  return {
    operationId: row.operation_id,
    revisionId: row.revision_id,
    generation: row.generation,
    desiredDigest: row.desired_digest,
    isReplayed: row.replayed,
  }
}

const observationInputSchema = z.object({
  projectRef: z.string().min(1).max(128),
  domain: z.string().min(1).max(64),
  desiredRevision: z.string().uuid(),
  observedGeneration: z.number().int().positive(),
  observedDocument: jsonValueSchema,
  operationId: z.string().min(1).max(128),
  observedAt: z.string().datetime({ offset: true }),
})

export async function applyConfigurationObservation(
  value: z.infer<typeof observationInputSchema>
): Promise<boolean> {
  const input = observationInputSchema.parse(value)
  const result = await executePlatformQuery<{ applied: boolean }>({
    query: `select platform.apply_configuration_observation(
      $1,$2,$3::uuid,$4,$5::jsonb,$6,$7::timestamptz
    ) as applied`,
    parameters: [
      input.projectRef,
      input.domain,
      input.desiredRevision,
      input.observedGeneration,
      JSON.stringify(input.observedDocument),
      input.operationId,
      input.observedAt,
    ],
  })
  if (result.error) throw result.error
  return z.object({ applied: z.boolean() }).parse(result.data?.[0]).applied
}

const operationSummarySchema = z.object({
  operation_id: z.string(),
  project_ref: z.string(),
  domain: z.string(),
  capability: z.string(),
  desired_revision: z.string().uuid(),
  desired_generation: z.coerce.number().int().positive(),
  desired_digest: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.string(),
  control_state: z.string().nullable(),
  error_code: z.string().nullable(),
  retryable: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

export async function getOperationSummary(projectRef: string, operationId: string) {
  if (!projectRef || !operationId) throw new Error('projectRef and operationId are required')
  const result = await executePlatformQuery({
    query: `select operation_id, project_ref, domain, capability, desired_revision,
      desired_generation, desired_digest, state, control_state, error_code,
      retryable, created_at, updated_at
    from platform.operation_summaries
    where project_ref = $1 and operation_id = $2`,
    parameters: [projectRef, operationId],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  return row === undefined ? null : operationSummarySchema.parse(row)
}
