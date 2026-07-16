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
  field_owners: unknown
  policy_revision: number
  cas_token: string
  drift_state: OwnershipPolicy['driftState']
  blockers: unknown
  last_operation_id: string | null
  last_observed_generation: number | null
  last_observed_digest: string | null
  last_observed_at: string | null
  desired_revision: string | null
  desired_generation: number | null
  desired_digest: string | null
  observed_revision: string | null
  observed_generation: number | null
  observed_digest: string | null
  updated_at: string
}

const policySelect = `select policy.project_ref, policy.domain, policy.ownership_mode, policy.adapter,
  field_owners, policy_revision, cas_token, drift_state, blockers, last_operation_id,
  last_observed_generation, last_observed_digest, last_observed_at,
  desired.revision_id as desired_revision,
  desired.generation as desired_generation,
  desired.desired_digest,
  observation.desired_revision as observed_revision,
  observation.observed_generation,
  observation.observed_digest,
  policy.updated_at
from platform.project_ownership_policies policy
left join platform.desired_configurations desired
  on desired.project_ref = policy.project_ref and desired.domain = policy.domain
left join platform.project_observations observation
  on observation.project_ref = policy.project_ref and observation.domain = policy.domain`

function mapPolicy(row: OwnershipPolicyRow): OwnershipPolicy {
  return ownershipPolicySchema.parse({
    projectRef: row.project_ref,
    domain: row.domain,
    ownershipMode: row.ownership_mode,
    adapter: row.adapter,
    fieldOwners: row.field_owners,
    policyRevision: Number(row.policy_revision),
    casToken: row.cas_token,
    driftState: row.drift_state,
    blockers: row.blockers ?? [],
    lastOperationId: row.last_operation_id,
    lastObservedGeneration:
      row.last_observed_generation === null ? null : Number(row.last_observed_generation),
    lastObservedDigest: row.last_observed_digest,
    lastObservedAt: row.last_observed_at,
    desiredRevision: row.desired_revision ?? null,
    desiredGeneration: row.desired_generation == null ? null : Number(row.desired_generation),
    desiredDigest: row.desired_digest ?? null,
    observedRevision: row.observed_revision ?? null,
    observedGeneration: row.observed_generation == null ? null : Number(row.observed_generation),
    observedDigest: row.observed_digest ?? null,
    updatedAt: row.updated_at,
  })
}

export async function listProjectOwnershipPolicies(projectRef: string): Promise<OwnershipPolicy[]> {
  if (!projectRef) throw new Error('projectRef is required')
  const result = await executePlatformQuery<OwnershipPolicyRow>({
    query: `${policySelect} where policy.project_ref = $1 order by policy.domain`,
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
    query: `select * from platform.set_project_ownership_policy($1,$2,$3,$4,$5,$6,$7::jsonb,$8::uuid)`,
    parameters: [
      input.projectRef,
      policy.domain,
      policy.ownershipMode,
      policy.expectedRevision,
      input.actor,
      input.correlationId,
      policy.fieldOwners === undefined ? null : JSON.stringify(policy.fieldOwners),
      policy.expectedCasToken ?? null,
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
