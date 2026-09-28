// [self-platform] Phase 2: apply stored Auth settings to a Fleet-managed stack.
//
// Studio renders the stored non-secret overrides into a Compose override for
// the `auth` service and commits it as the desired state of the `auth`
// configuration domain. The Agent writes the revision, recreates `auth`, and
// reports the revision applied only once the service is healthy.
//
// Stored secrets travel in a second override, `secrets.compose.yml`, sealed to
// the Fleet Agent's recipient key. The platform database, the operation
// record, and Fleet Control see only ciphertext.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { CapabilityUnavailable, requireProjectCapability } from './attachment'
import { readStoredAuthOverrides, readStoredAuthSecrets, SECRET_FIELDS } from './auth-config'
import {
  EMPTY_AUTH_SECRETS_OVERRIDE,
  planAuthRuntimeApply,
  renderAuthSecretsOverride,
  renderGotrueEnv,
} from './auth-runtime'
import { executePlatformQuery } from './db'
import { commitDesiredConfiguration } from './desired-state'
import {
  getAgentSecretRecipient,
  getProjectManagementBinding,
  type AgentSecretRecipient,
  type ManagementBinding,
} from './management-trust'
import { listProjectOwnershipPolicies, setProjectOwnershipPolicy } from './ownership-policy'
import {
  SEALED_SECRET_SCHEMA,
  sealedSecretFingerprint,
  sealSecret,
  type SealedSecretContext,
  type SealedSecretEnvelope,
} from './sealed-secret'
import { requirePlatformEncryptionKey } from './secrets'

export const AUTH_CONFIG_DOMAIN = 'auth'
const RECONCILE_CAPABILITY = 'runtime.config.reconcile'
const ROLLOUT_CAPABILITY = 'runtime.rollout'
const RECONCILE_INPUT_SCHEMA = 'supabase.fleet.runtime.config.reconcile.v1'
const OVERRIDE_PATH = 'compose.yml'
// World-readable: the override holds no secrets, and operators run
// `docker compose` on the host as their own user.
const OVERRIDE_MODE = 0o644
const SECRETS_PATH = 'secrets.compose.yml'
// Readable by the operator group only; the Agent sets the group on the target.
const SECRETS_MODE = 0o640

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
  /** Stored secret fields delivered sealed to the Fleet Agent, sorted. */
  sealedSecretFields: string[]
  /** Stored secret fields that cannot be delivered, sorted. */
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
  /** Identifies the planned sealed secrets, or null when none are delivered. */
  plannedSecrets: string | null
  hasOverrides: boolean
  desiredContent: string | null
  desiredSecrets: string | null
  operation: AuthApplyOperation | null
}): AuthApplyState {
  const matchesDesired =
    input.desiredContent !== null &&
    input.desiredContent === input.plannedContent &&
    input.desiredSecrets === input.plannedSecrets
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

const sealedEnvelopeSchema = z.object({
  schema: z.literal(SEALED_SECRET_SCHEMA),
  recipientKeyId: z.string(),
  ephemeralPublicKey: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
})

const overrideDocumentSchema = z.object({
  compose: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        content: z.string().default(''),
        sealed: z.object({ envelope: sealedEnvelopeSchema, fingerprint: z.string() }).optional(),
      })
    ),
  }),
})

type DesiredSealedSecrets = { envelope: SealedSecretEnvelope; fingerprint: string }

/** Compares sealed secrets by plaintext fingerprint and recipient key. */
export function sealedSecretsMarker(
  secrets: { fingerprint: string; recipientKeyId: string } | null
): string | null {
  return secrets === null ? null : `${secrets.fingerprint}:${secrets.recipientKeyId}`
}

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
  if (row === undefined) return { generation: 0, content: null, secrets: null }
  const parsed = desiredRowSchema.parse(row)
  const document = overrideDocumentSchema.safeParse(parsed.desired_document)
  const files = document.success ? document.data.compose.files : []
  const content = files.find((file) => file.path === OVERRIDE_PATH)?.content ?? null
  const secrets: DesiredSealedSecrets | null =
    files.find((file) => file.path === SECRETS_PATH)?.sealed ?? null
  return { generation: parsed.generation, content, secrets }
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

async function checkAvailability(
  binding: ManagementBinding | null,
  projectRef: string
): Promise<AuthApplyAvailability> {
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

type ApplyRequest = { actor: string; correlationId: string }

type SecretsPlan = {
  context: SealedSecretContext
  plaintext: string
  fingerprint: string
  recipient: AgentSecretRecipient
}

/**
 * Plans the sealed secrets override. Returns null when there is nothing to
 * seal or no Agent recipient key to seal to.
 */
function planSecrets(input: {
  binding: ManagementBinding
  secrets: Record<string, string>
  recipient: AgentSecretRecipient | null
}): SecretsPlan | null {
  if (input.recipient === null || Object.keys(renderGotrueEnv(input.secrets)).length === 0) {
    return null
  }
  const context = {
    projectRef: input.binding.projectRef,
    bindingId: input.binding.id,
    domain: AUTH_CONFIG_DOMAIN,
    path: SECRETS_PATH,
  }
  const plaintext = renderAuthSecretsOverride(input.secrets)
  return {
    context,
    plaintext,
    fingerprint: sealedSecretFingerprint({
      studioKey: requirePlatformEncryptionKey(),
      context,
      plaintext,
    }),
    recipient: input.recipient,
  }
}

async function loadApplyPlan(
  projectRef: string,
  request: ApplyRequest,
  options: { isStrict: boolean }
) {
  const binding = await getProjectManagementBinding(projectRef)
  const [overrides, secrets, desired, operation, availability, policies] = await Promise.all([
    readStoredAuthOverrides(projectRef),
    readStoredAuthSecrets(projectRef),
    readDesired(projectRef),
    readLatestApplyOperation(projectRef),
    checkAvailability(binding, projectRef),
    listProjectOwnershipPolicies(projectRef),
  ])
  const plan = planAuthRuntimeApply({
    config: overrides.config,
    storedSecretFields: overrides.secretFields,
    secretFieldNames: SECRET_FIELDS,
  })

  let recipient: AgentSecretRecipient | null = null
  if (binding && availability.isAvailable && plan.skippedSecretFields.length > 0) {
    try {
      recipient = await getAgentSecretRecipient({ projectRef, ...request })
    } catch (error) {
      // Status degrades to "secrets skipped"; an apply must not silently drop them.
      if (options.isStrict) throw error
    }
  }
  const secretsPlan = binding ? planSecrets({ binding, secrets, recipient }) : null
  const sealedSecretFields = secretsPlan === null ? [] : plan.skippedSecretFields
  const policy = policies.find((item) => item.domain === AUTH_CONFIG_DOMAIN)
  const status: AuthApplyStatus = {
    availability,
    state: deriveAuthApplyState({
      plannedContent: plan.content,
      plannedSecrets: sealedSecretsMarker(
        secretsPlan && {
          fingerprint: secretsPlan.fingerprint,
          recipientKeyId: secretsPlan.recipient.keyId,
        }
      ),
      hasOverrides: plan.appliedFields.length > 0 || secretsPlan !== null,
      desiredContent: desired.content,
      desiredSecrets: sealedSecretsMarker(
        desired.secrets && {
          fingerprint: desired.secrets.fingerprint,
          recipientKeyId: desired.secrets.envelope.recipientKeyId,
        }
      ),
      operation,
    }),
    isOwnedByFleet: policy?.ownershipMode === 'direct-managed',
    appliedFields: plan.appliedFields,
    sealedSecretFields,
    skippedSecretFields: secretsPlan === null ? plan.skippedSecretFields : [],
    expectedGeneration: desired.generation,
    operation,
  }
  return { binding, status, plan, secretsPlan, desired }
}

export async function getAuthApplyStatus(
  projectRef: string,
  request: ApplyRequest
): Promise<AuthApplyStatus> {
  return (await loadApplyPlan(projectRef, request, { isStrict: false })).status
}

/**
 * Reuses the desired envelope while the secrets and recipient are unchanged,
 * so the desired digest stays stable; otherwise seals again.
 */
export function sealedSecretsFile(
  plan: SecretsPlan,
  previous: DesiredSealedSecrets | null
): { path: string; content: string; mode: number; sealed: DesiredSealedSecrets } {
  const canReuse =
    previous !== null &&
    previous.fingerprint === plan.fingerprint &&
    previous.envelope.recipientKeyId === plan.recipient.keyId
  const envelope = canReuse
    ? previous.envelope
    : sealSecret({
        recipientPublicKey: plan.recipient.publicKey,
        context: plan.context,
        plaintext: plan.plaintext,
      })
  return {
    path: SECRETS_PATH,
    content: '',
    mode: SECRETS_MODE,
    sealed: { envelope, fingerprint: plan.fingerprint },
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
  const { binding, status, plan, secretsPlan, desired } = await loadApplyPlan(
    input.projectRef,
    { actor: input.actor, correlationId: input.correlationId },
    { isStrict: true }
  )
  if (!status.availability.isAvailable) {
    throw new AuthApplyConflict('apply_unavailable', status.availability.message)
  }
  if (status.state === 'applying') {
    throw new AuthApplyConflict('apply_in_progress', 'An Auth apply is already in progress.')
  }
  if (status.state === 'applied' || status.state === 'nothing-to-apply') {
    throw new AuthApplyConflict('nothing_to_apply', 'The Auth service already uses these settings.')
  }
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

  // Compose loads the secrets override on every start, so it always exists;
  // without secrets to deliver it is an empty, non-secret placeholder.
  const secretsFile =
    secretsPlan === null
      ? { path: SECRETS_PATH, content: EMPTY_AUTH_SECRETS_OVERRIDE, mode: OVERRIDE_MODE }
      : sealedSecretsFile(secretsPlan, desired.secrets)
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
        files: [{ path: OVERRIDE_PATH, content: plan.content, mode: OVERRIDE_MODE }, secretsFile],
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
