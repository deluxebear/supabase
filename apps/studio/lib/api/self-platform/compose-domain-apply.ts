// [self-platform] Applies Studio-owned settings to one service of a
// Fleet-managed Compose stack.
//
// Studio renders the settings into Compose override files and commits them as
// the desired state of one configuration domain. The Agent writes the
// revision, recreates the service, and reports the revision applied only once
// the service is healthy. Secrets travel in `secrets.compose.yml`, sealed to
// the Fleet Agent's recipient key: the platform database, the operation
// record, and Fleet Control see only ciphertext.
//
// Auth settings (auth-apply.ts) and Edge Function secrets
// (function-secrets-apply.ts) use this module.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { CapabilityUnavailable, requireProjectCapability } from './attachment'
import { toComposeOverrideYaml } from './auth-runtime'
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

export const SECRETS_OVERRIDE_PATH = 'secrets.compose.yml'
const RECONCILE_CAPABILITY = 'runtime.config.reconcile'
const ROLLOUT_CAPABILITY = 'runtime.rollout'
const RECONCILE_INPUT_SCHEMA = 'supabase.fleet.runtime.config.reconcile.v1'
// World-readable: plain overrides hold no secrets, and operators run
// `docker compose` on the host as their own user.
const PLAIN_MODE = 0o644
// Readable by the operator group only; the Agent sets the group on the target.
const SECRETS_MODE = 0o640
// Matches the sealed-secret plaintext limit.
const MAX_SECRETS_BYTES = 1 << 20

export type ComposeApplyAvailability =
  | { isAvailable: true }
  | { isAvailable: false; code: string; message: string }

export type ComposeApplyOperation = {
  id: string
  state: string
  errorCode: string | null
  updatedAt: string
}

export type ComposeApplyState = 'nothing-to-apply' | 'pending' | 'applying' | 'applied' | 'failed'

export class ComposeApplyConflict extends Error {
  constructor(
    public readonly code:
      | 'apply_unavailable'
      | 'ownership_confirmation_required'
      | 'nothing_to_apply'
      | 'apply_in_progress'
      | 'secrets_too_large',
    message: string
  ) {
    super(message)
    this.name = 'ComposeApplyConflict'
  }
}

export type PlainComposeFile = { path: string; content: string }

/** Identifies a set of plain files by path and content. */
export function plainFilesKey(files: PlainComposeFile[]): string {
  return JSON.stringify(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => [file.path, file.content])
  )
}

/** Compares sealed secrets by plaintext fingerprint and recipient key. */
export function sealedSecretsMarker(
  secrets: { fingerprint: string; recipientKeyId: string } | null
): string | null {
  return secrets === null ? null : `${secrets.fingerprint}:${secrets.recipientKeyId}`
}

/**
 * Derives where the stored settings are relative to the running service. The
 * desired revision is "applied" only after the Agent's evidence marked this
 * exact revision applied.
 */
export function deriveComposeApplyState(input: {
  /** plainFilesKey of the planned plain files. */
  plannedPlain: string
  /** Identifies the planned sealed secrets, or null when none are delivered. */
  plannedSecrets: string | null
  hasSettings: boolean
  /** plainFilesKey of the desired plain files, or null without a desired revision. */
  desiredPlain: string | null
  desiredSecrets: string | null
  operation: ComposeApplyOperation | null
}): ComposeApplyState {
  const matchesDesired =
    input.desiredPlain !== null &&
    input.desiredPlain === input.plannedPlain &&
    input.desiredSecrets === input.plannedSecrets
  if (!matchesDesired)
    return input.hasSettings || input.desiredPlain !== null ? 'pending' : 'nothing-to-apply'
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

const composeDocumentSchema = z.object({
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

type DesiredComposeDomain = {
  generation: number
  /** Plain files of the desired revision, or null without one. */
  plainFiles: PlainComposeFile[] | null
  secrets: DesiredSealedSecrets | null
}

async function readDesired(projectRef: string, domain: string): Promise<DesiredComposeDomain> {
  const result = await executePlatformQuery({
    query: `select generation, desired_document from platform.desired_configurations
      where project_ref = $1 and domain = $2`,
    parameters: [projectRef, domain],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  if (row === undefined) return { generation: 0, plainFiles: null, secrets: null }
  const parsed = desiredRowSchema.parse(row)
  const document = composeDocumentSchema.safeParse(parsed.desired_document)
  const files = document.success ? document.data.compose.files : []
  return {
    generation: parsed.generation,
    plainFiles: files
      .filter((file) => file.sealed === undefined)
      .map((file) => ({ path: file.path, content: file.content })),
    secrets: files.find((file) => file.path === SECRETS_OVERRIDE_PATH)?.sealed ?? null,
  }
}

const operationRowSchema = z.object({
  operation_id: z.string(),
  state: z.string(),
  error_code: z.string().nullable(),
  updated_at: z.coerce.string(),
})

async function readLatestApplyOperation(
  projectRef: string,
  domain: string
): Promise<ComposeApplyOperation | null> {
  const result = await executePlatformQuery({
    query: `select summary.operation_id, summary.state, summary.error_code, summary.updated_at
      from platform.operation_summaries summary
      join platform.operation_outbox outbox on outbox.operation_id = summary.operation_id
      where summary.project_ref = $1 and summary.domain = $2 and outbox.capability = $3
        and coalesce(outbox.preconditions->>'observationOnly', 'false') <> 'true'
      order by summary.created_at desc
      limit 1`,
    parameters: [projectRef, domain, RECONCILE_CAPABILITY],
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
  projectRef: string,
  label: string
): Promise<ComposeApplyAvailability> {
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
      message: `Applying ${label} is available for Compose targets only.`,
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

export type SealedSecretsPlan = {
  context: SealedSecretContext
  plaintext: string
  fingerprint: string
  recipient: AgentSecretRecipient
}

/**
 * Reuses the desired envelope while the secrets and recipient are unchanged,
 * so the desired digest stays stable; otherwise seals again.
 */
export function sealedSecretsFile(
  plan: SealedSecretsPlan,
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
    path: SECRETS_OVERRIDE_PATH,
    content: '',
    mode: SECRETS_MODE,
    sealed: { envelope, fingerprint: plan.fingerprint },
  }
}

/** Placeholder so Compose can always load the secrets override file. */
export function emptySecretsOverride(service: string): string {
  return toComposeOverrideYaml(
    service,
    {},
    '# Generated by Fleet. No secrets are delivered to this service. Do not edit.'
  )
}

export type ComposeDomainSpec = {
  domain: string
  /** Compose service that the override targets and Fleet recreates. */
  service: string
  /** Used in messages, for example "Auth settings". */
  label: string
}

export type ApplyRequest = { actor: string; correlationId: string }

/**
 * Plans an apply: the plain files, the sealed secrets (when there are
 * secrets and an Agent recipient key), and the resulting state.
 */
export async function loadComposeApplyPlan(input: {
  spec: ComposeDomainSpec
  projectRef: string
  request: ApplyRequest
  /** Throws when the recipient lookup fails instead of skipping secrets. */
  isStrict: boolean
  plainFiles: PlainComposeFile[]
  /** Rendered secrets override, or null when there are no secrets. */
  secretsPlaintext: string | null
  /** Whether the plain files carry any stored settings. */
  hasPlainSettings: boolean
}) {
  const { spec, projectRef } = input
  const binding = await getProjectManagementBinding(projectRef)
  const [desired, operation, availability, policies] = await Promise.all([
    readDesired(projectRef, spec.domain),
    readLatestApplyOperation(projectRef, spec.domain),
    checkAvailability(binding, projectRef, spec.label),
    listProjectOwnershipPolicies(projectRef),
  ])

  let recipient: AgentSecretRecipient | null = null
  if (binding && availability.isAvailable && input.secretsPlaintext !== null) {
    try {
      recipient = await getAgentSecretRecipient({ projectRef, ...input.request })
    } catch (error) {
      // Status degrades to "secrets skipped"; an apply must not silently drop them.
      if (input.isStrict) throw error
    }
  }

  let secretsPlan: SealedSecretsPlan | null = null
  if (binding && recipient && input.secretsPlaintext !== null) {
    const context = {
      projectRef: binding.projectRef,
      bindingId: binding.id,
      domain: spec.domain,
      path: SECRETS_OVERRIDE_PATH,
    }
    secretsPlan = {
      context,
      plaintext: input.secretsPlaintext,
      fingerprint: sealedSecretFingerprint({
        studioKey: requirePlatformEncryptionKey(),
        context,
        plaintext: input.secretsPlaintext,
      }),
      recipient,
    }
  }

  // Compose loads the secrets override on every start, so it always exists;
  // without secrets to deliver it is an empty, non-secret placeholder.
  const plainFiles =
    secretsPlan === null
      ? [
          ...input.plainFiles,
          { path: SECRETS_OVERRIDE_PATH, content: emptySecretsOverride(spec.service) },
        ]
      : input.plainFiles

  const policy = policies.find((item) => item.domain === spec.domain)
  const state = deriveComposeApplyState({
    plannedPlain: plainFilesKey(plainFiles),
    plannedSecrets: sealedSecretsMarker(
      secretsPlan && {
        fingerprint: secretsPlan.fingerprint,
        recipientKeyId: secretsPlan.recipient.keyId,
      }
    ),
    hasSettings: input.hasPlainSettings || secretsPlan !== null,
    desiredPlain: desired.plainFiles === null ? null : plainFilesKey(desired.plainFiles),
    desiredSecrets: sealedSecretsMarker(
      desired.secrets && {
        fingerprint: desired.secrets.fingerprint,
        recipientKeyId: desired.secrets.envelope.recipientKeyId,
      }
    ),
    operation,
  })
  return {
    spec,
    projectRef,
    binding,
    availability,
    state,
    isOwnedByFleet: policy?.ownershipMode === 'direct-managed',
    areSecretsSealed: secretsPlan !== null,
    expectedGeneration: desired.generation,
    operation,
    plainFiles,
    secretsPlan,
    desired,
  }
}

export type ComposeApplyPlan = Awaited<ReturnType<typeof loadComposeApplyPlan>>

/** Commits a plan from loadComposeApplyPlan as the domain's desired revision. */
export async function commitComposeApply(
  plan: ComposeApplyPlan,
  input: {
    expectedGeneration: number
    confirmOwnership: boolean
    idempotencyKey: string
    actor: string
    correlationId: string
    aal?: string
    aalAuthenticatedAt?: number
  }
) {
  const { spec, projectRef, binding } = plan
  if (!plan.availability.isAvailable) {
    throw new ComposeApplyConflict('apply_unavailable', plan.availability.message)
  }
  if (plan.state === 'applying') {
    throw new ComposeApplyConflict('apply_in_progress', `Applying ${spec.label} is in progress.`)
  }
  if (plan.state === 'applied' || plan.state === 'nothing-to-apply') {
    throw new ComposeApplyConflict('nothing_to_apply', `The ${spec.label} are already applied.`)
  }
  if (!binding) {
    throw new ComposeApplyConflict(
      'apply_unavailable',
      'The project management binding is missing.'
    )
  }
  if (plan.secretsPlan && Buffer.byteLength(plan.secretsPlan.plaintext) > MAX_SECRETS_BYTES) {
    throw new ComposeApplyConflict(
      'secrets_too_large',
      `The ${spec.label} exceed 1 MiB and cannot be delivered.`
    )
  }

  // Fleet only writes a domain the operator explicitly handed over (A16).
  if (!plan.isOwnedByFleet) {
    if (!input.confirmOwnership) {
      throw new ComposeApplyConflict(
        'ownership_confirmation_required',
        `Confirm that Fleet manages the ${spec.service} service configuration before applying.`
      )
    }
    const current = (await listProjectOwnershipPolicies(projectRef)).find(
      (item) => item.domain === spec.domain
    )
    await setProjectOwnershipPolicy({
      projectRef,
      policy: {
        domain: spec.domain,
        ownershipMode: 'direct-managed',
        expectedRevision: current?.policyRevision ?? 0,
        expectedCasToken: current?.casToken ?? null,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
  }

  const files = [
    ...plan.plainFiles.map((file) => ({ ...file, mode: PLAIN_MODE })),
    ...(plan.secretsPlan ? [sealedSecretsFile(plan.secretsPlan, plan.desired.secrets)] : []),
  ]
  return commitDesiredConfiguration({
    projectRef,
    domain: spec.domain,
    capability: RECONCILE_CAPABILITY,
    expectedGeneration: input.expectedGeneration,
    operationId: `${spec.domain}_apply_${randomUUID()}`,
    targetId: binding.managementTargetId,
    bindingId: binding.id,
    inputSchema: RECONCILE_INPUT_SCHEMA,
    idempotencyKey: input.idempotencyKey,
    desiredDocument: {
      ownershipMode: 'direct-managed',
      adapter: 'compose',
      compose: { files, rollout: [spec.service] },
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
