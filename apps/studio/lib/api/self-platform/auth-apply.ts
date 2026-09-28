// [self-platform] Phase 2: apply stored Auth settings to a Fleet-managed stack.
//
// Non-secret overrides go to `compose.yml` for the `auth` service; stored
// secrets go to `secrets.compose.yml`, sealed to the Fleet Agent. See
// compose-domain-apply.ts for the apply mechanics.
import { readStoredAuthOverrides, readStoredAuthSecrets, SECRET_FIELDS } from './auth-config'
import { planAuthRuntimeApply, renderAuthSecretsOverride, renderGotrueEnv } from './auth-runtime'
import {
  commitComposeApply,
  loadComposeApplyPlan,
  type ApplyRequest,
  type ComposeApplyAvailability,
  type ComposeApplyOperation,
  type ComposeApplyState,
  type ComposeDomainSpec,
} from './compose-domain-apply'

export const AUTH_CONFIG_DOMAIN = 'auth'
const OVERRIDE_PATH = 'compose.yml'
const AUTH_SPEC: ComposeDomainSpec = {
  domain: AUTH_CONFIG_DOMAIN,
  service: 'auth',
  label: 'Auth settings',
}

export type AuthApplyStatus = {
  availability: ComposeApplyAvailability
  state: ComposeApplyState
  isOwnedByFleet: boolean
  appliedFields: string[]
  /** Stored secret fields delivered sealed to the Fleet Agent, sorted. */
  sealedSecretFields: string[]
  /** Stored secret fields that cannot be delivered, sorted. */
  skippedSecretFields: string[]
  expectedGeneration: number
  operation: ComposeApplyOperation | null
}

async function loadAuthApplyPlan(projectRef: string, request: ApplyRequest, isStrict: boolean) {
  const [overrides, secrets] = await Promise.all([
    readStoredAuthOverrides(projectRef),
    readStoredAuthSecrets(projectRef),
  ])
  const plan = planAuthRuntimeApply({
    config: overrides.config,
    storedSecretFields: overrides.secretFields,
    secretFieldNames: SECRET_FIELDS,
  })
  const hasSecrets = Object.keys(renderGotrueEnv(secrets)).length > 0
  const applyPlan = await loadComposeApplyPlan({
    spec: AUTH_SPEC,
    projectRef,
    request,
    isStrict,
    plainFiles: [{ path: OVERRIDE_PATH, content: plan.content }],
    secretsPlaintext: hasSecrets ? renderAuthSecretsOverride(secrets) : null,
    hasPlainSettings: plan.appliedFields.length > 0,
  })
  const status: AuthApplyStatus = {
    availability: applyPlan.availability,
    state: applyPlan.state,
    isOwnedByFleet: applyPlan.isOwnedByFleet,
    appliedFields: plan.appliedFields,
    sealedSecretFields: applyPlan.areSecretsSealed ? plan.skippedSecretFields : [],
    skippedSecretFields: applyPlan.areSecretsSealed ? [] : plan.skippedSecretFields,
    expectedGeneration: applyPlan.expectedGeneration,
    operation: applyPlan.operation,
  }
  return { applyPlan, status }
}

export async function getAuthApplyStatus(
  projectRef: string,
  request: ApplyRequest
): Promise<AuthApplyStatus> {
  return (await loadAuthApplyPlan(projectRef, request, false)).status
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
  const { applyPlan } = await loadAuthApplyPlan(
    input.projectRef,
    { actor: input.actor, correlationId: input.correlationId },
    true
  )
  return commitComposeApply(applyPlan, input)
}
