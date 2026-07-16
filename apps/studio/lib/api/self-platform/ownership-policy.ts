import { z } from 'zod'

import { executePlatformQuery } from './db'
import {
  ownershipPolicyInputSchema,
  ownershipPolicySchema,
  type OwnershipPolicy,
} from './ownership-policy.shared'

export {
  ownershipModeSchema,
  ownershipPolicyInputSchema,
  ownershipPolicySchema,
  type OwnershipPolicy,
} from './ownership-policy.shared'

type OwnershipPolicyRow = {
  project_ref: string
  domain: string
  ownership_mode: OwnershipPolicy['ownershipMode']
  adapter: OwnershipPolicy['adapter']
  policy_revision: number
  drift_state: OwnershipPolicy['driftState']
  blockers: unknown
  last_operation_id: string | null
  last_observed_generation: number | null
  last_observed_digest: string | null
  last_observed_at: string | null
  updated_at: string
}

const policySelect = `select project_ref, domain, ownership_mode, adapter,
  policy_revision, drift_state, blockers, last_operation_id,
  last_observed_generation, last_observed_digest, last_observed_at, updated_at
from platform.project_ownership_policies`

function mapPolicy(row: OwnershipPolicyRow): OwnershipPolicy {
  return ownershipPolicySchema.parse({
    projectRef: row.project_ref,
    domain: row.domain,
    ownershipMode: row.ownership_mode,
    adapter: row.adapter,
    policyRevision: Number(row.policy_revision),
    driftState: row.drift_state,
    blockers: row.blockers ?? [],
    lastOperationId: row.last_operation_id,
    lastObservedGeneration:
      row.last_observed_generation === null ? null : Number(row.last_observed_generation),
    lastObservedDigest: row.last_observed_digest,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at,
  })
}

export async function listProjectOwnershipPolicies(projectRef: string): Promise<OwnershipPolicy[]> {
  if (!projectRef) throw new Error('projectRef is required')
  const result = await executePlatformQuery<OwnershipPolicyRow>({
    query: `${policySelect} where project_ref = $1 order by domain`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return (result.data ?? []).map(mapPolicy)
}

export class OwnershipPolicyConflict extends Error {
  readonly code: 'configuration_conflict' | 'capability_unavailable' | 'management_target_unbound'

  constructor(code: OwnershipPolicyConflict['code'], message: string) {
    super(message)
    this.name = 'OwnershipPolicyConflict'
    this.code = code
  }
}

export async function setProjectOwnershipPolicy(input: {
  projectRef: string
  policy: z.infer<typeof ownershipPolicyInputSchema>
  actor: string
  correlationId: string
}): Promise<OwnershipPolicy> {
  const policy = ownershipPolicyInputSchema.parse(input.policy)
  const result = await executePlatformQuery<OwnershipPolicyRow>({
    query: `select * from platform.set_project_ownership_policy($1,$2,$3,$4,$5,$6)`,
    parameters: [
      input.projectRef,
      policy.domain,
      policy.ownershipMode,
      policy.expectedRevision,
      input.actor,
      input.correlationId,
    ],
  })
  if (result.error) {
    for (const code of [
      'configuration_conflict',
      'capability_unavailable',
      'management_target_unbound',
    ] as const) {
      if (result.error.message.includes(code)) {
        throw new OwnershipPolicyConflict(code, result.error.message)
      }
    }
    throw result.error
  }
  return mapPolicy(result.data?.[0] as OwnershipPolicyRow)
}
