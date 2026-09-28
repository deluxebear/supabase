import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { requireProjectCapability } from './attachment'
import { executePlatformQuery } from './db'
import { fleetOperationSchema, getFleetOperation } from './fleet-operations'
import {
  getAgentSecretRecipient,
  ManagementTrustConflict,
  requestManagementDomain,
  syncProjectManagementBinding,
} from './management-trust'
import { getProjectByRef } from './projects'
import { sealSecret } from './sealed-secret'
import { decryptSecret, encryptSecret } from './secrets'

export const databaseSecurityPolicySchema = z.object({
  generation: z.number().int().nonnegative(),
  ssl: z.object({ enforced: z.boolean(), caReference: z.string().max(512) }),
  network: z.object({ allowedCidrs: z.array(z.string()).max(128) }),
  pooler: z.object({
    defaultPoolSize: z.number().int().min(1).max(1000),
    maxClientConnections: z.number().int().min(10).max(100000),
  }),
  state: z.enum(['ready', 'applying', 'failed']),
  operationId: z.string().nullable(),
  errorCode: z.string().nullable(),
  observedAt: z.string().nullable(),
})

export const updateDatabaseSecuritySchema = databaseSecurityPolicySchema
  .pick({ ssl: true, network: true, pooler: true })
  .extend({ expectedGeneration: z.number().int().nonnegative() })

export const rotateDatabasePasswordSchema = z.object({
  expectedGeneration: z.number().int().nonnegative(),
  role: z.enum(['primary', 'read-only']),
  newPassword: z
    .string()
    .min(12)
    .max(256)
    .refine((value) => !value.includes('\0')),
})

type Policy = z.infer<typeof databaseSecurityPolicySchema>
type PolicyRow = {
  generation: number
  ssl_enforced: boolean
  tls_ca_reference: string | null
  allowed_cidrs: unknown
  default_pool_size: number
  max_client_connections: number
  state: 'ready' | 'applying' | 'failed'
  operation_id: string | null
  error_code: string | null
  observed_at: string | null
}

function rowToPolicy(row: PolicyRow): Policy {
  return databaseSecurityPolicySchema.parse({
    generation: Number(row.generation),
    ssl: { enforced: row.ssl_enforced, caReference: row.tls_ca_reference ?? '' },
    network: { allowedCidrs: row.allowed_cidrs },
    pooler: {
      defaultPoolSize: row.default_pool_size,
      maxClientConnections: row.max_client_connections,
    },
    state: row.state,
    operationId: row.operation_id,
    errorCode: row.error_code,
    observedAt: row.observed_at,
  })
}

export async function getDatabaseSecurityPolicy(projectRef: string): Promise<Policy> {
  const result = await executePlatformQuery<PolicyRow>({
    query: `insert into platform.database_security_policies(project_ref) values ($1)
      on conflict (project_ref) do update set project_ref = excluded.project_ref
      returning generation, ssl_enforced, tls_ca_reference, allowed_cidrs,
        default_pool_size, max_client_connections,
        state, operation_id, error_code, observed_at`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return rowToPolicy(result.data?.[0] as PolicyRow)
}

async function requireDatabaseBinding(projectRef: string, actor: string, correlationId: string) {
  const binding = await syncProjectManagementBinding({ projectRef, actor, correlationId })
  await requireProjectCapability(projectRef, 'database.security.reconcile')
  if (
    binding.state !== 'active' ||
    binding.targetState !== 'active' ||
    !isDatabaseSecurityAdapter(binding.deploymentKind)
  ) {
    throw new Error(
      'An active Compose or Kubernetes management binding and database Agent are required'
    )
  }
  return { ...binding, deploymentKind: binding.deploymentKind }
}

// The Agent's database runtime works over the network on both.
function isDatabaseSecurityAdapter(kind: string): kind is 'compose' | 'kubernetes' {
  return kind === 'compose' || kind === 'kubernetes'
}

async function reserveGeneration(
  projectRef: string,
  expectedGeneration: number,
  operationId: string
) {
  const result = await executePlatformQuery<{ generation: number }>({
    query: `insert into platform.database_security_policies(project_ref, generation, state, operation_id)
      values ($1, 1, 'applying', $3)
      on conflict (project_ref) do update set generation = platform.database_security_policies.generation + 1,
        state = 'applying', operation_id = $3, error_code = null, updated_at = now()
      where platform.database_security_policies.generation = $2
      returning generation`,
    parameters: [projectRef, expectedGeneration, operationId],
  })
  if (result.error) throw result.error
  const generation = Number(result.data?.[0]?.generation ?? 0)
  if (generation < 1) throw new Error('Database security settings changed; reload and try again')
  return generation
}

async function markFailed(projectRef: string, operationId: string, errorCode: string) {
  const result = await executePlatformQuery({
    query: `update platform.database_security_policies
      set state = 'failed', error_code = $3, observed_at = now(), updated_at = now()
      where project_ref = $1 and operation_id = $2`,
    parameters: [projectRef, operationId, errorCode],
  })
  if (result.error) throw result.error
}

async function markReady(
  projectRef: string,
  operationId: string,
  policy: Omit<Policy, 'generation' | 'state' | 'operationId' | 'errorCode' | 'observedAt'>
) {
  const result = await executePlatformQuery({
    query: `update platform.database_security_policies set
      ssl_enforced = $3, tls_ca_reference = nullif($4, ''), allowed_cidrs = $5::jsonb,
      default_pool_size = $6, max_client_connections = $7,
      state = 'ready', error_code = null,
      observed_at = now(), updated_at = now()
      where project_ref = $1 and operation_id = $2`,
    parameters: [
      projectRef,
      operationId,
      policy.ssl.enforced,
      policy.ssl.caReference,
      JSON.stringify(policy.network.allowedCidrs),
      policy.pooler.defaultPoolSize,
      policy.pooler.maxClientConnections,
    ],
  })
  if (result.error) throw result.error
}

async function waitForTerminalOperation(input: {
  projectRef: string
  operationId: string
  actor: string
  correlationId: string
}) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const operation = await getFleetOperation(input)
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(operation.state))
      return operation
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error('Database security operation did not finish before the safety timeout')
}

async function executeDatabaseSecurityOperation(input: {
  projectRef: string
  expectedGeneration: number
  policy: Pick<Policy, 'ssl' | 'network' | 'pooler'>
  rotation?: { role: 'primary' | 'read-only'; currentPassword: string; newPassword: string }
  idempotencyKey: string
  actor: string
  correlationId: string
}) {
  const binding = await requireDatabaseBinding(input.projectRef, input.actor, input.correlationId)
  // Passwords travel sealed to the Fleet Agent, so Fleet Control and its
  // database never hold them. Checked before reserving a generation.
  const recipient =
    input.rotation === undefined
      ? null
      : await getAgentSecretRecipient({
          projectRef: input.projectRef,
          actor: input.actor,
          correlationId: input.correlationId,
        })
  if (input.rotation !== undefined && recipient === null) {
    throw new ManagementTrustConflict(
      'secret_recipient_unavailable',
      "This stack's Fleet Agent has not published a key for receiving secrets. Upgrade the Agent before rotating database passwords."
    )
  }
  const operationId = `database_${randomUUID()}`
  const generation = await reserveGeneration(
    input.projectRef,
    input.expectedGeneration,
    operationId
  )
  const document = {
    adapter: binding.deploymentKind,
    ssl: input.policy.ssl,
    network: input.policy.network,
    pooler: input.policy.pooler,
    ...(input.rotation === undefined || recipient === null
      ? {}
      : {
          sealedRotation: {
            role: input.rotation.role,
            // Bound to this operation, so the envelope cannot be replayed.
            envelope: sealSecret({
              recipientPublicKey: recipient.publicKey,
              context: {
                projectRef: input.projectRef,
                bindingId: binding.id,
                domain: 'fleet.database',
                path: `rotation/${input.rotation.role}/${operationId}`,
              },
              plaintext: JSON.stringify({
                currentPassword: input.rotation.currentPassword,
                newPassword: input.rotation.newPassword,
              }),
            }),
          },
        }),
  }
  const snapshotCanonical = JSON.stringify(document)
  const desiredDigest = createHash('sha256').update(snapshotCanonical).digest('hex')
  let operation: z.infer<typeof fleetOperationSchema>
  try {
    const raw = await requestManagementDomain(binding, 'fleet-control', {
      method: 'POST',
      path: `/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/operations`,
      body: {
        operationId,
        targetId: binding.managementTargetId,
        bindingId: binding.id,
        domain: 'fleet.database',
        capability: 'database.security.reconcile',
        protocolMajor: 1,
        protocolMinor: 0,
        expectedGeneration: generation,
        desiredRevision: randomUUID(),
        desiredDigest,
        snapshotCanonical,
        inputSchema: 'supabase.fleet.database.security.reconcile.v1',
        preconditions: {},
        typedInput: document,
      },
      scopes: ['fleet.execute'],
      actor: input.actor,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
    })
    const created = fleetOperationSchema.parse(raw)
    operation = await waitForTerminalOperation({
      projectRef: input.projectRef,
      operationId: created.id,
      actor: input.actor,
      correlationId: input.correlationId,
    })
  } catch (error) {
    await markFailed(input.projectRef, operationId, 'operation_failed')
    throw error
  }
  if (operation.state !== 'succeeded') {
    await markFailed(input.projectRef, operationId, operation.errorCode ?? operation.state)
    throw new Error(`Database security operation failed: ${operation.errorCode ?? operation.state}`)
  }
  await markReady(input.projectRef, operationId, input.policy)
  return { operationId, generation, state: operation.state as 'succeeded' }
}

export function updateDatabaseSecurity(input: {
  projectRef: string
  value: z.infer<typeof updateDatabaseSecuritySchema>
  idempotencyKey: string
  actor: string
  correlationId: string
}) {
  const value = updateDatabaseSecuritySchema.parse(input.value)
  return executeDatabaseSecurityOperation({
    ...input,
    expectedGeneration: value.expectedGeneration,
    policy: value,
  })
}

export async function rotateDatabasePassword(input: {
  projectRef: string
  value: z.infer<typeof rotateDatabasePasswordSchema>
  idempotencyKey: string
  actor: string
  correlationId: string
}) {
  const value = rotateDatabasePasswordSchema.parse(input.value)
  const [policy, project] = await Promise.all([
    getDatabaseSecurityPolicy(input.projectRef),
    getProjectByRef(input.projectRef),
  ])
  if (!project) throw new Error('Project not found')
  const encryptedCurrent =
    value.role === 'read-only'
      ? (project.db_pass_readonly_enc ?? project.db_pass_enc)
      : project.db_pass_enc
  const currentPassword = decryptSecret(encryptedCurrent)
  const result = await executeDatabaseSecurityOperation({
    ...input,
    expectedGeneration: value.expectedGeneration,
    policy,
    rotation: { role: value.role, currentPassword, newPassword: value.newPassword },
  })
  const encrypted = encryptSecret(value.newPassword)
  const column = value.role === 'read-only' ? 'db_pass_readonly_enc' : 'db_pass_enc'
  const resultUpdate = await executePlatformQuery({
    query: `with project_update as (
        update platform.projects set ${column} = $2, updated_at = now() where ref = $1
      )
      update platform.project_connection_revisions
      set connection_document = jsonb_set(connection_document, $3::text[], to_jsonb($2::text), true)
      where project_ref = $1 and state = 'active'`,
    parameters: [input.projectRef, encrypted, [column]],
  })
  if (resultUpdate.error) throw resultUpdate.error
  return result
}
