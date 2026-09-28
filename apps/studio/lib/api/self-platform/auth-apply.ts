// [self-platform] Phase 2: apply stored Auth settings to a Fleet-managed stack.
//
// Studio renders the stored non-secret overrides into a Compose override for
// the `auth` service and commits it as the desired state of the `auth`
// configuration domain. The Agent writes the revision, recreates `auth`, and
// reports the revision applied only once the service is healthy.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { CapabilityUnavailable, requireProjectCapability } from './attachment'
import { readStoredAuthOverrides, SECRET_FIELDS } from './auth-config'
import { planAuthRuntimeApply } from './auth-runtime'
import { executePlatformQuery } from './db'
import { commitDesiredConfiguration } from './desired-state'
import { getProjectManagementBinding } from './management-trust'
import { listProjectOwnershipPolicies, setProjectOwnershipPolicy } from './ownership-policy'

export const AUTH_CONFIG_DOMAIN = 'auth'
const RECONCILE_CAPABILITY = 'runtime.config.reconcile'
const ROLLOUT_CAPABILITY = 'runtime.rollout'
const RECONCILE_INPUT_SCHEMA = 'supabase.fleet.runtime.config.reconcile.v1'
const OVERRIDE_PATH = 'compose.yml'
// World-readable: the override holds no secrets, and operators run
// `docker compose` on the host as their own user.
const OVERRIDE_MODE = 0o644

export type AuthApplyAvailability =
  | { isAvailable: true }
  | { isAvailable: false; code: string; message: string }

export type AuthApplyOperation = {
  id: string
  state: string
  errorCode: string | null
  updatedAt: string
}

export type AuthApplyState = 'nothing-to-apply' | 'pending' | 'applying' | 'applied' | 'failed'

export type AuthApplyStatus = {
  availability: AuthApplyAvailability
  state: AuthApplyState
  isOwnedByFleet: boolean
  appliedFields: string[]
  skippedSecretFields: string[]
  expectedGeneration: number
  operation: AuthApplyOperation | null
}

export class AuthApplyConflict extends Error {
  constructor(
    public readonly code:
      | 'apply_unavailable'
      | 'ownership_confirmation_required'
      | 'nothing_to_apply'
      | 'apply_in_progress',
    message: string
  ) {
    super(message)
    this.name = 'AuthApplyConflict'
  }
}

/**
 * Derives where the stored settings are relative to the running Auth
 * service. The desired revision is "applied" only after the Agent's evidence
 * marked this exact revision applied.
 */
export function deriveAuthApplyState(input: {
  plannedContent: string
  hasOverrides: boolean
  desiredContent: string | null
  operation: AuthApplyOperation | null
}): AuthApplyState {
  const matchesDesired =
    input.desiredContent !== null && input.desiredContent === input.plannedContent
  if (!matchesDesired)
    return input.hasOverrides || input.desiredContent !== null ? 'pending' : 'nothing-to-apply'
  switch (input.operation?.state) {
    case 'applied':
      return 'applied'
    case 'failed':
      return 'failed'
    case 'queued':
      return 'applying'
    default:
      // No operation for this revision, or a newer commit superseded it.
      return 'pending'
  }
}

const desiredRowSchema = z.object({
  generation: z.coerce.number().int().nonnegative(),
  desired_document: z.unknown(),
})

const overrideDocumentSchema = z.object({
  compose: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string() })),
  }),
})

const operationRowSchema = z.object({
  operation_id: z.string(),
  state: z.string(),
  error_code: z.string().nullable(),
  updated_at: z.coerce.string(),
})

async function readDesired(projectRef: string) {
  const result = await executePlatformQuery({
    query: `select generation, desired_document from platform.desired_configurations
      where project_ref = $1 and domain = $2`,
    parameters: [projectRef, AUTH_CONFIG_DOMAIN],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  if (row === undefined) return { generation: 0, content: null }
  const parsed = desiredRowSchema.parse(row)
  const document = overrideDocumentSchema.safeParse(parsed.desired_document)
  const content = document.success
    ? (document.data.compose.files.find((file) => file.path === OVERRIDE_PATH)?.content ?? null)
    : null
  return { generation: parsed.generation, content }
}

async function readLatestApplyOperation(projectRef: string): Promise<AuthApplyOperation | null> {
  const result = await executePlatformQuery({
    query: `select summary.operation_id, summary.state, summary.error_code, summary.updated_at
      from platform.operation_summaries summary
      join platform.operation_outbox outbox on outbox.operation_id = summary.operation_id
      where summary.project_ref = $1 and summary.domain = $2 and outbox.capability = $3
        and coalesce(outbox.preconditions->>'observationOnly', 'false') <> 'true'
      order by summary.created_at desc
      limit 1`,
    parameters: [projectRef, AUTH_CONFIG_DOMAIN, RECONCILE_CAPABILITY],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  if (row === undefined) return null
  const parsed = operationRowSchema.parse(row)
  return {
    id: parsed.operation_id,
    state: parsed.state,
    errorCode: parsed.error_code,
    updatedAt: parsed.updated_at,
  }
}

async function checkAvailability(projectRef: string): Promise<AuthApplyAvailability> {
  const binding = await getProjectManagementBinding(projectRef)
  if (!binding || binding.state !== 'active' || binding.targetState !== 'active') {
    return {
      isAvailable: false,
      code: 'management_target_unbound',
      message: 'This project needs an active management binding and an online Fleet Agent.',
    }
  }
  if (binding.deploymentKind !== 'compose') {
    return {
      isAvailable: false,
      code: 'capability_unavailable',
      message: 'Applying Auth settings is available for Compose targets only.',
    }
  }
  for (const capability of [RECONCILE_CAPABILITY, ROLLOUT_CAPABILITY]) {
    try {
      await requireProjectCapability(projectRef, capability)
    } catch (error) {
      if (!(error instanceof CapabilityUnavailable)) throw error
      return {
        isAvailable: false,
        code: 'capability_unavailable',
        message: `The Fleet Agent does not provide ${capability}. Enable the lifecycle overlay on the managed stack.`,
      }
    }
  }
  return { isAvailable: true }
}

export async function getAuthApplyStatus(projectRef: string): Promise<AuthApplyStatus> {
  const [overrides, desired, operation, availability, policies] = await Promise.all([
    readStoredAuthOverrides(projectRef),
    readDesired(projectRef),
    readLatestApplyOperation(projectRef),
    checkAvailability(projectRef),
    listProjectOwnershipPolicies(projectRef),
  ])
  const plan = planAuthRuntimeApply({
    config: overrides.config,
    storedSecretFields: overrides.secretFields,
    secretFieldNames: SECRET_FIELDS,
  })
  const policy = policies.find((item) => item.domain === AUTH_CONFIG_DOMAIN)
  return {
    availability,
    state: deriveAuthApplyState({
      plannedContent: plan.content,
      hasOverrides: plan.appliedFields.length > 0,
      desiredContent: desired.content,
      operation,
    }),
    isOwnedByFleet: policy?.ownershipMode === 'direct-managed',
    appliedFields: plan.appliedFields,
    skippedSecretFields: plan.skippedSecretFields,
    expectedGeneration: desired.generation,
    operation,
  }
}

export async function applyAuthConfig(input: {
  projectRef: string
  expectedGeneration: number
  confirmOwnership: boolean
  idempotencyKey: string
  actor: string
  correlationId: string
  aal?: string
  aalAuthenticatedAt?: number
}) {
  const status = await getAuthApplyStatus(input.projectRef)
  if (!status.availability.isAvailable) {
    throw new AuthApplyConflict('apply_unavailable', status.availability.message)
  }
  if (status.state === 'applying') {
    throw new AuthApplyConflict('apply_in_progress', 'An Auth apply is already in progress.')
  }
  if (status.state === 'applied' || status.state === 'nothing-to-apply') {
    throw new AuthApplyConflict('nothing_to_apply', 'The Auth service already uses these settings.')
  }
  const binding = await getProjectManagementBinding(input.projectRef)
  if (!binding) {
    throw new AuthApplyConflict('apply_unavailable', 'The project management binding is missing.')
  }

  // Fleet only writes a domain the operator explicitly handed over (A16).
  if (!status.isOwnedByFleet) {
    if (!input.confirmOwnership) {
      throw new AuthApplyConflict(
        'ownership_confirmation_required',
        'Confirm that Fleet manages the Auth service configuration before applying.'
      )
    }
    const current = (await listProjectOwnershipPolicies(input.projectRef)).find(
      (item) => item.domain === AUTH_CONFIG_DOMAIN
    )
    await setProjectOwnershipPolicy({
      projectRef: input.projectRef,
      policy: {
        domain: AUTH_CONFIG_DOMAIN,
        ownershipMode: 'direct-managed',
        expectedRevision: current?.policyRevision ?? 0,
        expectedCasToken: current?.casToken ?? null,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
  }

  const overrides = await readStoredAuthOverrides(input.projectRef)
  const plan = planAuthRuntimeApply({
    config: overrides.config,
    storedSecretFields: overrides.secretFields,
    secretFieldNames: SECRET_FIELDS,
  })
  return commitDesiredConfiguration({
    projectRef: input.projectRef,
    domain: AUTH_CONFIG_DOMAIN,
    capability: RECONCILE_CAPABILITY,
    expectedGeneration: input.expectedGeneration,
    operationId: `auth_apply_${randomUUID()}`,
    targetId: binding.managementTargetId,
    bindingId: binding.id,
    inputSchema: RECONCILE_INPUT_SCHEMA,
    idempotencyKey: input.idempotencyKey,
    desiredDocument: {
      ownershipMode: 'direct-managed',
      adapter: 'compose',
      compose: {
        files: [{ path: OVERRIDE_PATH, content: plan.content, mode: OVERRIDE_MODE }],
        rollout: ['auth'],
      },
    },
    preconditions: {
      ...(input.aal === undefined ? {} : { aal: input.aal }),
      ...(input.aalAuthenticatedAt === undefined
        ? {}
        : { aalAuthenticatedAt: input.aalAuthenticatedAt }),
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
}
