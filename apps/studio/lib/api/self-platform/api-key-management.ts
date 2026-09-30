import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { getNonPlatformApiKeys, type NonPlatformApiKey } from '../self-hosted/api-keys'
import { executePlatformQuery } from './db'
import { ConfigurationConflictError } from './desired-state'
import { readVerifiedJWTObservation } from './jwt-configuration'
import { resolveProjectConnection } from './resolve-connection'
import { decryptSecret, encryptSecret } from './secrets'
import {
  commitServiceConfigApply,
  loadServiceConfigApplyPlan,
  ServiceConfigApplyConflict,
  type ApplyRequest,
  type ServiceConfigSpec,
} from './service-config-apply'

const SPEC: ServiceConfigSpec = {
  domain: 'api-keys',
  service: 'kong',
  label: 'API keys',
  secretsHeader: '# Fleet-managed Envoy API keys',
  supportsKubernetes: false,
}
const REGISTRY_PATH = 'registry.enc'
const keySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(128),
  description: z.string().max(1024),
  type: z.enum(['publishable', 'secret']),
  api_key: z.string().regex(/^sb_(publishable|secret)_[A-Za-z0-9_-]+$/),
  hash: z.string(),
  prefix: z.string(),
})
const keysSchema = z.array(keySchema).max(100)
const documentSchema = z.object({
  compose: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string().optional() })),
  }),
})
export const apiKeyCreateSchema = z
  .object({
    type: z.enum(['publishable', 'secret']),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(1024).nullable().optional(),
    secret_jwt_template: z.object({ role: z.literal('service_role') }).optional(),
  })
  .strict()
export const apiKeyUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(1024).nullable().optional(),
  })
  .strict()

export function createManagedAPIKey(input: z.infer<typeof apiKeyCreateSchema>): NonPlatformApiKey {
  const value = `sb_${input.type}_${randomBytes(32).toString('base64url')}`
  return {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? '',
    type: input.type,
    api_key: value,
    prefix: input.type === 'secret' ? value.slice(0, 15) : '',
    hash: '',
  }
}

export function renderManagedAPIKeys(keys: NonPlatformApiKey[]) {
  const validated = keysSchema.parse(keys)
  return validated.map((key) => `${key.api_key}=${key.type}`).join(',')
}

function keysFromDocument(document: unknown): NonPlatformApiKey[] {
  const parsed = documentSchema.parse(document)
  const file = parsed.compose.files.find((file) => file.path === REGISTRY_PATH)
  if (!file?.content) throw new Error('The Fleet API key registry is missing')
  return keysSchema.parse(JSON.parse(decryptSecret(file.content)))
}

/** Only successful Agent revisions become visible as usable API keys. */
export async function listManagedAPIKeys(
  projectRef: string,
  resolved?: Awaited<ReturnType<typeof resolveProjectConnection>>
): Promise<NonPlatformApiKey[]> {
  const conn = resolved ?? (await resolveProjectConnection(projectRef))
  const registered = getNonPlatformApiKeys(conn)
  const result = await executePlatformQuery({
    query: `select revision.desired_document
      from platform.configuration_revisions revision
      join platform.operation_outbox outbox on outbox.desired_revision = revision.revision_id
      join platform.operation_summaries summary on summary.operation_id = outbox.operation_id
      where revision.project_ref = $1 and revision.domain = 'api-keys'
        and summary.state = 'applied'
      order by revision.generation desc limit 1`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  if (!result.data?.[0]) return registered
  return [
    ...registered.filter((key) => key.type === 'legacy'),
    ...keysFromDocument(
      z.object({ desired_document: z.unknown() }).parse(result.data[0]).desired_document
    ),
  ]
}

export async function mutateManagedAPIKeys(input: {
  projectRef: string
  change:
    | { kind: 'create'; input: z.infer<typeof apiKeyCreateSchema> }
    | { kind: 'delete'; id: string }
    | { kind: 'update'; id: string; input: z.infer<typeof apiKeyUpdateSchema> }
  request: ApplyRequest
  idempotencyKey: string
  aal?: string
  aalAuthenticatedAt?: number
}) {
  const replay = await executePlatformQuery({
    query: `select outbox.operation_id, revision.desired_document from platform.operation_outbox outbox
      join platform.configuration_revisions revision on revision.revision_id = outbox.desired_revision
      where outbox.project_ref = $1 and outbox.domain = 'api-keys' and outbox.idempotency_key = $2`,
    parameters: [input.projectRef, input.idempotencyKey],
  })
  if (replay.error) throw replay.error
  if (replay.data?.[0]) {
    const row = z
      .object({ operation_id: z.string(), desired_document: z.unknown() })
      .parse(replay.data[0])
    const keys = keysFromDocument(row.desired_document)
    const { change } = input
    const changed =
      change.kind === 'create' ? keys[keys.length - 1] : keys.find((key) => key.id === change.id)
    await waitForAPIKeyOperation(input.projectRef, String(row.operation_id))
    return (
      changed ?? {
        id: input.change.kind === 'create' ? '' : input.change.id,
        name: '',
        description: '',
        type: 'secret' as const,
        api_key: '',
        hash: '',
        prefix: '',
      }
    )
  }
  const snapshotResult = await executePlatformQuery({
    query: `select desired.generation, summary.state from platform.desired_configurations desired
      left join platform.operation_outbox outbox on outbox.desired_revision = desired.revision_id
        and outbox.capability = 'runtime.config.reconcile'
        and coalesce(outbox.preconditions->>'observationOnly', 'false') <> 'true'
      left join platform.operation_summaries summary on summary.operation_id = outbox.operation_id
      where desired.project_ref = $1 and desired.domain = 'api-keys'
      order by outbox.created_at desc limit 1`,
    parameters: [input.projectRef],
  })
  if (snapshotResult.error) throw snapshotResult.error
  const snapshot = snapshotResult.data?.[0]
    ? z
        .object({ generation: z.coerce.number().int(), state: z.string().nullable() })
        .parse(snapshotResult.data[0])
    : { generation: 0, state: null }
  if (
    snapshot.generation > 0 &&
    !['applied', 'failed', 'superseded', 'cancelled'].includes(snapshot.state ?? '')
  )
    throw new ServiceConfigApplyConflict(
      'apply_in_progress',
      'Fleet is already updating the API keys. Wait for the current operation to finish.'
    )
  const observed = await readVerifiedJWTObservation(input.projectRef)
  if (!observed?.credentials.apiKeysGateway)
    throw new ServiceConfigApplyConflict(
      'apply_unavailable',
      'Upgrade the Fleet Agent and managed Envoy gateway before managing API keys.'
    )
  const current = (await listManagedAPIKeys(input.projectRef)).filter(
    (key) => key.type !== 'legacy'
  )
  if (
    observed.credentials.gatewayAPIKeysManaged &&
    renderManagedAPIKeys(current) !== observed.credentials.gatewayAPIKeys
  )
    throw new ServiceConfigApplyConflict(
      'apply_unavailable',
      'The running gateway keys differ from the last applied revision. Reconcile the gateway before editing API keys.'
    )
  let changed: NonPlatformApiKey
  let next: NonPlatformApiKey[]
  if (input.change.kind === 'create') {
    if (current.length >= 100)
      throw new ServiceConfigApplyConflict(
        'apply_unavailable',
        'The project has reached its limit of 100 API keys.'
      )
    changed = createManagedAPIKey(input.change.input)
    next = [...current, changed]
  } else {
    const { change } = input
    const existing = current.find((key) => key.id === change.id)
    if (!existing)
      throw new ServiceConfigApplyConflict(
        'apply_unavailable',
        'The API key was not found. Legacy JWT keys cannot be deleted here.'
      )
    changed =
      change.kind === 'update'
        ? {
            ...existing,
            ...change.input,
            description:
              change.input.description === undefined
                ? existing.description
                : (change.input.description ?? ''),
          }
        : existing
    next =
      change.kind === 'delete'
        ? current.filter((key) => key.id !== change.id)
        : current.map((key) => (key.id === change.id ? changed : key))
  }
  const plan = await loadServiceConfigApplyPlan({
    spec: SPEC,
    projectRef: input.projectRef,
    request: input.request,
    isStrict: true,
    plainFiles: [{ path: REGISTRY_PATH, content: encryptSecret(JSON.stringify(next)) }],
    secretsEnv: { FLEET_API_KEYS_MANAGED: 'true', FLEET_API_KEYS: renderManagedAPIKeys(next) },
    hasPlainSettings: true,
  })
  if (plan.expectedGeneration !== snapshot.generation) throw new ConfigurationConflictError()
  if (plan.secretsPlan === null)
    throw new ServiceConfigApplyConflict(
      'apply_unavailable',
      'An online Fleet Agent with sealed-secret support is required.'
    )
  const operation = await commitServiceConfigApply(plan, {
    ...input.request,
    expectedGeneration: plan.expectedGeneration,
    confirmOwnership: true,
    idempotencyKey: input.idempotencyKey,
    aal: input.aal,
    aalAuthenticatedAt: input.aalAuthenticatedAt,
  })
  // The existing dialogs expect a usable key rather than an operation receipt.
  // Waiting here keeps their success state tied to a healthy gateway rollout.
  await waitForAPIKeyOperation(input.projectRef, operation.operationId)
  return changed
}

async function waitForAPIKeyOperation(projectRef: string, operationId: string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const result = await executePlatformQuery({
      query: `select state, error_code from platform.operation_summaries where operation_id = $1 and project_ref = $2`,
      parameters: [operationId, projectRef],
    })
    if (result.error) throw result.error
    const state = result.data?.[0]
      ? z.object({ state: z.string() }).parse(result.data[0]).state
      : undefined
    if (state === 'applied') return
    if (state === 'failed' || state === 'superseded' || state === 'cancelled')
      throw new ServiceConfigApplyConflict(
        'apply_unavailable',
        'Fleet could not apply the API key configuration. Reload the list before retrying.'
      )
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new ServiceConfigApplyConflict(
    'apply_in_progress',
    'Fleet is still updating the gateway. Refresh the API key list to check the result before retrying.'
  )
}
