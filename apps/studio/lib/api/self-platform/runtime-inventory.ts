import { createHash, randomUUID } from 'node:crypto'

import { requireProjectCapability } from './attachment'
import { executePlatformQuery } from './db'
import { fleetOperationSchema, getFleetOperation } from './fleet-operations'
import { requestManagementDomain, syncProjectManagementBinding } from './management-trust'
import { runtimeInventorySchema, type RuntimeInventory } from './runtime-inventory-contract'

export { runtimeInventorySchema, type RuntimeInventory } from './runtime-inventory-contract'

type InventoryRow = {
  generation: number
  state: 'pending' | 'refreshing' | 'ready' | 'failed'
  evidence: unknown
  error_code: string | null
  observed_at: string | null
}

async function readProjection(projectRef: string) {
  const result = await executePlatformQuery<InventoryRow>({
    query: `insert into platform.runtime_inventories(project_ref) values ($1)
      on conflict (project_ref) do update set project_ref = excluded.project_ref
      returning generation, state, evidence, error_code, observed_at`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return result.data?.[0]
}

async function reserveGeneration(projectRef: string, operationId: string) {
  const result = await executePlatformQuery<{ generation: number }>({
    query: `insert into platform.runtime_inventories(project_ref, generation, state, operation_id)
      values ($1, 1, 'refreshing', $2)
      on conflict (project_ref) do update set
        generation = platform.runtime_inventories.generation + 1,
        state = 'refreshing', operation_id = $2, error_code = null, updated_at = now()
      returning generation`,
    parameters: [projectRef, operationId],
  })
  if (result.error) throw result.error
  return Number(result.data?.[0]?.generation ?? 0)
}

async function waitForTerminal(input: {
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
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error('Runtime inventory operation did not finish before the safety timeout')
}

async function markFailed(projectRef: string, operationId: string, errorCode: string) {
  const result = await executePlatformQuery({
    query: `update platform.runtime_inventories set state = 'failed', error_code = $3,
      updated_at = now() where project_ref = $1 and operation_id = $2`,
    parameters: [projectRef, operationId, errorCode],
  })
  if (result.error) throw result.error
}

async function storeEvidence(projectRef: string, operationId: string, evidence: RuntimeInventory) {
  const result = await executePlatformQuery({
    query: `update platform.runtime_inventories set state = 'ready', evidence = $3::jsonb,
      error_code = null, observed_at = $4, updated_at = now()
      where project_ref = $1 and operation_id = $2`,
    parameters: [projectRef, operationId, JSON.stringify(evidence), evidence.observedAt],
  })
  if (result.error) throw result.error
}

export async function getRuntimeInventory(input: {
  projectRef: string
  actor: string
  correlationId: string
  force?: boolean
}) {
  const projected = await readProjection(input.projectRef)
  const parsed = runtimeInventorySchema.safeParse(projected?.evidence)
  const observedAt = projected?.observed_at ? Date.parse(projected.observed_at) : 0
  if (!input.force && parsed.success && Date.now() - observedAt < 30_000) return parsed.data

  const binding = await syncProjectManagementBinding(input)
  await requireProjectCapability(input.projectRef, 'runtime.observe')
  if (
    binding.state !== 'active' ||
    binding.targetState !== 'active' ||
    binding.deploymentKind !== 'compose'
  ) {
    throw new Error('An active Compose management binding and runtime inventory Agent are required')
  }
  const operationId = `inventory_${randomUUID()}`
  const generation = await reserveGeneration(input.projectRef, operationId)
  const document = { services: [] as string[] }
  const snapshotCanonical = JSON.stringify(document)
  const desiredDigest = createHash('sha256').update(snapshotCanonical).digest('hex')
  let failureCode = 'inventory_failed'
  try {
    const raw = await requestManagementDomain(binding, 'fleet-control', {
      method: 'POST',
      path: `/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/operations`,
      body: {
        operationId,
        targetId: binding.managementTargetId,
        bindingId: binding.id,
        domain: 'fleet.runtime',
        capability: 'runtime.observe',
        protocolMajor: 1,
        protocolMinor: 0,
        expectedGeneration: generation,
        desiredRevision: randomUUID(),
        desiredDigest,
        snapshotCanonical,
        inputSchema: 'supabase.fleet.runtime.observe.v1',
        preconditions: {},
        typedInput: document,
      },
      scopes: ['fleet.execute'],
      actor: input.actor,
      correlationId: input.correlationId,
      idempotencyKey: `runtime-inventory:${input.projectRef}:${generation}`,
    })
    const created = fleetOperationSchema.parse(raw)
    const operation = await waitForTerminal({ ...input, operationId: created.id })
    if (operation.state !== 'succeeded') {
      failureCode = operation.errorCode ?? operation.state
      throw new Error(`Runtime inventory failed: ${failureCode}`)
    }
    const evidence = runtimeInventorySchema.parse(operation.evidence)
    if (evidence.observedGeneration !== generation)
      throw new Error('Runtime inventory generation does not match the reserved projection')
    await storeEvidence(input.projectRef, operationId, evidence)
    return evidence
  } catch (error) {
    await markFailed(input.projectRef, operationId, failureCode)
    throw error
  }
}

export function serviceVersion(inventory: RuntimeInventory, service: string) {
  return inventory.versions.find((item) => item.service === service)?.version ?? ''
}
