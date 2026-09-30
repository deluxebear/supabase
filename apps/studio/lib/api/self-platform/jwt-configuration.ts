import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import { executePlatformQuery } from './db'
import { getAgentJWTObservation } from './management-trust'
import { mintServiceJwt } from './mint-jwt'
import { resolveProjectConnection } from './resolve-connection'
import { openSecret, SEALED_SECRET_SCHEMA, studioObservationRecipient } from './sealed-secret'
import { encryptSecret, requirePlatformEncryptionKey } from './secrets'
import {
  commitServiceConfigApply,
  loadServiceConfigApplyPlan,
  ServiceConfigApplyConflict,
  type ApplyRequest,
  type ServiceConfigSpec,
} from './service-config-apply'

export const JWT_SERVICES = [
  'auth',
  'rest',
  'storage',
  'realtime',
  'functions',
  'kong',
  'supavisor',
]
const SPEC: ServiceConfigSpec = {
  domain: 'jwt',
  service: 'auth',
  label: 'JWT configuration',
  secretsHeader: '# Fleet-managed legacy JWT configuration',
  supportsKubernetes: false,
  rolloutServices: JWT_SERVICES,
}
const envelopeSchema = z.object({
  schema: z.literal(SEALED_SECRET_SCHEMA),
  recipientKeyId: z.string().length(32),
  ephemeralPublicKey: z.string(),
  nonce: z.string(),
  ciphertext: z.string().max(32768),
})
const observationSchema = z.object({
  schema: z.literal('supabase.fleet.jwt.observation.v1'),
  projectRef: z.string(),
  bindingId: z.string(),
  observedAt: z.string().datetime({ offset: true }),
  sealed: envelopeSchema,
})
const credentialsSchema = z.object({
  secret: z.string().min(32).max(4096),
  anonKey: z.string().max(16384),
  serviceKey: z.string().max(16384),
  observedAt: z.string().datetime({ offset: true }),
})
export const jwtConfigurationInputSchema = z
  .object({
    secret: z
      .string()
      .min(32)
      .max(4096)
      .regex(/^[^\r\n\0]+$/),
    expectedGeneration: z.number().int().nonnegative(),
    confirmOwnership: z.boolean(),
    confirmTokenInvalidation: z.literal(true),
  })
  .strict()

export function verifyLegacyJWT(token: string, secret: string, role: string, now = Date.now()) {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const header = z
      .object({ alg: z.literal('HS256') })
      .parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString()))
    const claims = z
      .object({ role: z.string(), exp: z.number() })
      .parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString()))
    const signature = Buffer.from(parts[2], 'base64url')
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()
    return (
      header.alg === 'HS256' &&
      claims.role === role &&
      claims.exp * 1000 > now &&
      signature.length === expected.length &&
      timingSafeEqual(signature, expected)
    )
  } catch {
    return false
  }
}

export function renderJWTOverride(input: { secret: string; anonKey: string; serviceKey: string }) {
  const { secret, anonKey, serviceKey } = input
  return JSON.stringify({
    services: {
      auth: { environment: { GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_KEYS: '[]' } },
      rest: { environment: { PGRST_JWT_SECRET: secret, PGRST_APP_SETTINGS_JWT_SECRET: secret } },
      storage: {
        environment: { AUTH_JWT_SECRET: secret, ANON_KEY: anonKey, SERVICE_KEY: serviceKey },
      },
      realtime: { environment: { API_JWT_SECRET: secret, METRICS_JWT_SECRET: secret } },
      functions: {
        environment: {
          JWT_SECRET: secret,
          SUPABASE_ANON_KEY: anonKey,
          SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        },
      },
      supavisor: { environment: { API_JWT_SECRET: secret, METRICS_JWT_SECRET: secret } },
      kong: { environment: { SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_KEY: serviceKey } },
    },
  })
}

// The envelope, timestamp, token roles and current binding must all agree.
export async function syncJWTConfiguration(projectRef: string) {
  const report = await getAgentJWTObservation(projectRef)
  if (!report) return null
  const parsed = observationSchema.safeParse(report.observation)
  if (!parsed.success) return null
  const observation = parsed.data
  const now = Date.now(),
    observedAt = Date.parse(observation.observedAt)
  if (
    observation.projectRef !== projectRef ||
    observation.bindingId !== report.binding.id ||
    observedAt > now + 60_000 ||
    observedAt < now - 120_000
  )
    return null
  const recipient = studioObservationRecipient(requirePlatformEncryptionKey())
  const credentials = credentialsSchema.parse(
    JSON.parse(
      openSecret({
        recipientPrivateKey: recipient.privateKey,
        context: {
          projectRef,
          bindingId: report.binding.id,
          domain: 'jwt-observation',
          path: 'runtime.json',
        },
        envelope: observation.sealed,
      })
    )
  )
  if (
    credentials.observedAt !== observation.observedAt ||
    !verifyLegacyJWT(credentials.anonKey, credentials.secret, 'anon') ||
    !verifyLegacyJWT(credentials.serviceKey, credentials.secret, 'service_role')
  )
    return null
  const conn = await resolveProjectConnection(projectRef)
  if (!conn.row || conn.row.key_mode !== 'legacy-jwt') return null
  const isChanged =
    conn.jwtSecret !== credentials.secret ||
    conn.anonKey !== credentials.anonKey ||
    conn.serviceKey !== credentials.serviceKey
  const result = await executePlatformQuery({
    query: `update platform.projects set jwt_secret_enc=$2, anon_key_enc=$3, service_key_enc=$4, jwt_observed_at=$5
      where ref=$1 and jwt_secret_enc is not distinct from $6 and key_mode='legacy-jwt'
      and (jwt_observed_at is null or jwt_observed_at < $5::timestamptz)
      and exists (select 1 from platform.project_management_bindings where project_ref=$1 and id=$7 and state='active')`,
    parameters: [
      projectRef,
      isChanged ? encryptSecret(credentials.secret) : conn.row.jwt_secret_enc,
      isChanged ? encryptSecret(credentials.anonKey) : conn.row.anon_key_enc,
      isChanged ? encryptSecret(credentials.serviceKey) : conn.row.service_key_enc,
      observation.observedAt,
      conn.row.jwt_secret_enc,
      report.binding.id,
    ],
  })
  if (result.error) throw result.error
  return observation.observedAt
}

async function loadPlan(
  projectRef: string,
  request: ApplyRequest,
  isStrict: boolean,
  credentials?: { secret: string; anonKey: string; serviceKey: string }
) {
  const conn = await resolveProjectConnection(projectRef)
  const plaintext = renderJWTOverride(
    credentials ?? { secret: conn.jwtSecret, anonKey: conn.anonKey, serviceKey: conn.serviceKey }
  )
  const plan = await loadServiceConfigApplyPlan({
    spec: SPEC,
    projectRef,
    request,
    isStrict,
    plainFiles: [],
    secretsEnv: { JWT_SECRET: credentials?.secret ?? conn.jwtSecret },
    hasPlainSettings: false,
    secretsPlaintext: plaintext,
  })
  if (!conn.row || conn.row.key_mode !== 'legacy-jwt' || !conn.jwtSecret)
    plan.availability = {
      isAvailable: false,
      code: 'legacy_jwt_required',
      message: 'JWT configuration requires a registered legacy HS256 project.',
    }
  if (plan.availability.isAvailable && plan.secretsPlan === null)
    plan.availability = {
      isAvailable: false,
      code: 'secret_recipient_unavailable',
      message: 'An online Fleet Agent with sealed-secret support is required.',
    }
  return plan
}

export async function getJWTConfigurationStatus(projectRef: string, request: ApplyRequest) {
  const observedAt = await syncJWTConfiguration(projectRef)
  const plan = await loadPlan(projectRef, request, false)
  const operation = plan.operation
  const isApplying =
    operation && ['queued', 'claimed', 'running', 'applying', 'retrying'].includes(operation.state)
  let state = plan.state
  if (operation?.state === 'failed') state = 'failed'
  if (isApplying) state = 'applying'
  return {
    availability: plan.availability,
    state,
    expectedGeneration: plan.expectedGeneration,
    isOwnedByFleet: plan.isOwnedByFleet,
    operation,
    observedAt,
    recipientPublicKey: studioObservationRecipient(
      requirePlatformEncryptionKey()
    ).publicKey.toString('base64'),
    services: JWT_SERVICES,
  }
}

export async function applyJWTConfiguration(
  input: z.infer<typeof jwtConfigurationInputSchema> & {
    projectRef: string
    actor: string
    correlationId: string
    idempotencyKey: string
    aal?: string
    aalAuthenticatedAt?: number
  }
) {
  const observedAt = await syncJWTConfiguration(input.projectRef)
  if (!observedAt)
    throw new ServiceConfigApplyConflict(
      'apply_unavailable',
      'A fresh, consistent JWT observation from the Fleet Agent is required before changing keys.'
    )
  const current = await resolveProjectConnection(input.projectRef)
  if (current.jwtSecret === input.secret)
    throw new ServiceConfigApplyConflict(
      'nothing_to_apply',
      'The new JWT secret must differ from the running registered secret.'
    )
  const credentials = {
    secret: input.secret,
    anonKey: mintServiceJwt(input.secret, 'anon', 10 * 365 * 24 * 60 * 60),
    serviceKey: mintServiceJwt(input.secret, 'service_role', 10 * 365 * 24 * 60 * 60),
  }
  const plan = await loadPlan(
    input.projectRef,
    { actor: input.actor, correlationId: input.correlationId },
    true,
    credentials
  )
  if (plan.operation?.state === 'queued')
    throw new ServiceConfigApplyConflict(
      'apply_in_progress',
      'A JWT configuration operation is already running.'
    )
  if (plan.operation && Date.parse(observedAt) <= Date.parse(plan.operation.updatedAt))
    throw new ServiceConfigApplyConflict(
      'apply_unavailable',
      'Wait for a consistent JWT observation after the previous operation before changing keys again.'
    )
  return commitServiceConfigApply(plan, input)
}

let timer: ReturnType<typeof setInterval> | undefined
let isSyncing = false
export function startJWTConfigurationSync() {
  if (timer) return
  const cycle = async () => {
    if (isSyncing) return
    isSyncing = true
    try {
      const result = await executePlatformQuery<{ ref: string }>({
        query:
          "select ref from platform.projects where key_mode='legacy-jwt' and detached_at is null",
      })
      if (result.error) return
      for (const { ref } of result.data ?? []) {
        try {
          await syncJWTConfiguration(ref)
        } catch {
          /* Never log credentials or envelope errors. */
        }
      }
    } finally {
      isSyncing = false
    }
  }
  timer = setInterval(() => void cycle(), 30_000)
  timer.unref?.()
  void cycle()
}
