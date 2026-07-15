import { randomUUID } from 'node:crypto'

import { requireProjectCapability } from './attachment'
import { executePlatformQuery } from './db'
import { commitDesiredConfiguration } from './desired-state'
import {
  lifecycleComponentVersionsSchema,
  lifecycleExecuteInputSchema,
  lifecycleImpactPlanSchema,
  lifecyclePlanInputSchema,
  type LifecycleAction,
  type LifecycleExecuteInput,
  type LifecyclePlanInput,
} from './lifecycle-contract'
import { getProjectManagementBinding, requestManagementDomain } from './management-trust'
import { listProjectOwnershipPolicies } from './ownership-policy'

export {
  lifecycleActionSchema,
  lifecycleExecuteInputSchema,
  lifecyclePlanInputSchema,
} from './lifecycle-contract'

export class LifecycleConflict extends Error {
  constructor(
    readonly code:
      | 'capability_unavailable'
      | 'management_target_unbound'
      | 'ownership_conflict'
      | 'plan_confirmation_invalid',
    message: string
  ) {
    super(message)
    this.name = 'LifecycleConflict'
  }
}

function configuredVersions() {
  const raw = process.env.FLEET_LIFECYCLE_COMPONENT_VERSIONS
  if (!raw)
    throw new LifecycleConflict(
      'capability_unavailable',
      'Lifecycle component discovery is not configured on the Studio server.'
    )
  try {
    return lifecycleComponentVersionsSchema.parse(JSON.parse(raw))
  } catch {
    throw new LifecycleConflict(
      'capability_unavailable',
      'Lifecycle component discovery is incomplete or invalid.'
    )
  }
}

function ownershipDomain(action: LifecycleAction) {
  return action.startsWith('runtime.')
    ? 'runtime'
    : action.startsWith('network.')
      ? 'network'
      : action.startsWith('branch.')
        ? 'branch'
        : 'postgres'
}

export async function getLifecycleGeneration(projectRef: string, action: LifecycleAction) {
  const result = await executePlatformQuery<{ generation: number }>({
    query:
      'select generation from platform.desired_configurations where project_ref = $1 and domain = $2',
    parameters: [projectRef, ownershipDomain(action)],
  })
  if (result.error) throw result.error
  return Number(result.data?.[0]?.generation ?? 0)
}

async function bindingFor(
  projectRef: string,
  action: LifecycleAction,
  requiresMutation: boolean
) {
  await requireProjectCapability(projectRef, action)
  const binding = await getProjectManagementBinding(projectRef)
  if (!binding || binding.state !== 'active' || binding.targetState !== 'active')
    throw new LifecycleConflict(
      'management_target_unbound',
      'An active project management binding and Agent are required.'
    )
  if (!['compose', 'kubernetes'].includes(binding.deploymentKind))
    throw new LifecycleConflict(
      'capability_unavailable',
      'Lifecycle providers support only explicitly configured Compose or Kubernetes targets.'
    )
  if (requiresMutation) {
    const domain = ownershipDomain(action)
    const policy = (await listProjectOwnershipPolicies(projectRef)).find(
      (item) => item.domain === domain
    )
    if (!policy || policy.ownershipMode !== 'direct-managed')
      throw new LifecycleConflict(
        'ownership_conflict',
        `Set the ${domain} ownership policy to direct-managed before executing this lifecycle action.`
      )
  }
  return binding
}

export async function createLifecycleImpactPlan(input: {
  projectRef: string
  value: LifecyclePlanInput
  actor: string
  correlationId: string
}) {
  const value = lifecyclePlanInputSchema.parse(input.value)
  const binding = await bindingFor(input.projectRef, value.action, false)
  const response = await requestManagementDomain(binding, 'fleet-control', {
    method: 'POST',
    path: `/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/lifecycle/impact-plans`,
    body: {
      targetId: binding.managementTargetId,
      bindingId: binding.id,
      action: value.action,
      adapter: binding.deploymentKind,
      parameters: value.parameters,
      componentVersions: configuredVersions(),
    },
    scopes: ['fleet.execute'],
    actor: input.actor,
    correlationId: input.correlationId,
  })
  return lifecycleImpactPlanSchema.parse(response)
}

export async function executeLifecyclePlan(input: {
  projectRef: string
  value: LifecycleExecuteInput
  actor: string
  correlationId: string
  aal?: string
  aalAuthenticatedAt?: number
}) {
  const value = lifecycleExecuteInputSchema.parse(input.value)
  if (value.plan.projectRef !== input.projectRef || Date.parse(value.plan.expiresAt) <= Date.now())
    throw new LifecycleConflict(
      'plan_confirmation_invalid',
      'The lifecycle impact plan is expired or belongs to another project.'
    )
  const binding = await bindingFor(input.projectRef, value.plan.action, true)
  if (binding.deploymentKind !== value.plan.adapter)
    throw new LifecycleConflict(
      'plan_confirmation_invalid',
      'The management adapter changed after impact planning.'
    )
  const versions = configuredVersions()
  if (JSON.stringify(versions) !== JSON.stringify(value.plan.componentVersions))
    throw new LifecycleConflict(
      'plan_confirmation_invalid',
      'Component versions changed after impact planning; create a new plan.'
    )
  const document = {
    schema: 'supabase.fleet.lifecycle.execute.v1' as const,
    action: value.plan.action,
    adapter: value.plan.adapter,
    parameters: value.plan.parameters,
    componentVersions: value.plan.componentVersions,
    planId: value.plan.id,
    planHash: value.plan.hash,
    planExpiresAt: value.plan.expiresAt,
  }
  return commitDesiredConfiguration({
    projectRef: input.projectRef,
    domain: ownershipDomain(value.plan.action),
    capability: value.plan.action,
    expectedGeneration: value.expectedGeneration,
    operationId: `lifecycle_${randomUUID()}`,
    targetId: binding.managementTargetId,
    bindingId: binding.id,
    inputSchema: 'supabase.fleet.lifecycle.execute.v1',
    idempotencyKey: value.idempotencyKey,
    desiredDocument: JSON.parse(JSON.stringify(document)),
    preconditions: {
      planHash: value.plan.hash,
      ...(input.aal === undefined ? {} : { aal: input.aal }),
      ...(input.aalAuthenticatedAt === undefined
        ? {}
        : { aalAuthenticatedAt: input.aalAuthenticatedAt }),
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
}
