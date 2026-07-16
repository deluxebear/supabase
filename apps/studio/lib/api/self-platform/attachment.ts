import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { constructHeaders } from '@/lib/api/apiHelpers'
import { encryptString } from '@/lib/api/self-hosted/util'
import { projectCapabilityAt } from '@/lib/api/self-platform/capability-liveness'
import { executePlatformQuery } from '@/lib/api/self-platform/db'
import { getProjectPgMetaBaseUrl } from '@/lib/api/self-platform/pg-meta'
import { decryptSecret, encryptSecret } from '@/lib/api/self-platform/secrets'

export const KEY_MODES = ['legacy-jwt', 'asymmetric-jwks', 'mixed'] as const
export const TLS_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const

export type ProjectKeyMode = (typeof KEY_MODES)[number]
export type ProjectTlsMode = (typeof TLS_MODES)[number]
export type PreflightCheckStatus = 'pass' | 'fail' | 'warning' | 'unsupported'

export interface AttachmentConnectionInput {
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  dbUserReadonly: string
  dbPass: string
  dbPassReadonly: string | null
  kongUrl: string
  restUrl: string
  anonKey: string
  serviceKey: string
  jwtSecret: string
  publishableKey: string | null
  secretKey: string | null
  keyMode: ProjectKeyMode
  tlsMode: ProjectTlsMode
  tlsCaReference: string | null
  logflareUrl: string | null
  logflareToken: string | null
}

export interface PreflightCheck {
  name: string
  status: PreflightCheckStatus
  required: boolean
  message: string
  remediation?: string
  evidence?: Record<string, unknown>
}

export interface AttachmentPreflightReport {
  contractVersion: 'v1'
  startedAt: string
  completedAt: string
  outcome: 'pass' | 'fail'
  stackFingerprint: string | null
  checks: PreflightCheck[]
}

export interface ProjectCapabilityRecord {
  name: string
  state: 'available' | 'unavailable' | 'unauthorized' | 'stale' | 'unsupported'
  mode: 'direct' | 'operator' | 'agent' | 'kubernetes-job' | 'unsupported'
  source: 'static-profile' | 'preflight' | 'service-probe' | 'operator' | 'agent'
  contractVersion: string | null
  targetVersion: string | null
  observationRevision: string
  observedAt: string
  validUntil: string | null
  blockers: Array<{ code: string; message: string; remediation?: string }>
}

export interface ProjectAttachmentStatus {
  attachmentState: 'draft' | 'validating' | 'active' | 'detaching' | 'detached' | 'failed'
  dataPlaneHealth: 'unknown' | 'healthy' | 'degraded' | 'unreachable'
  managementConnectivity: 'unconfigured' | 'online' | 'offline' | 'incompatible' | 'revoked'
  targetConnectivity: 'unconfigured' | 'online' | 'offline' | 'incompatible' | 'revoked'
  agentConnectivity: 'unconfigured' | 'online' | 'stale' | 'offline' | 'incompatible' | 'revoked'
  driftState: 'unknown' | 'in-sync' | 'drifted' | 'ownership-conflict'
  operationState: 'idle' | 'active' | 'manual-intervention'
  fingerprintProofState: 'unverified' | 'verified' | 'revoked'
  keyMode: ProjectKeyMode
  activeConnectionRevision: number
  firstVerifiedAt: string | null
  lastVerifiedAt: string | null
  statusObservedAt: string
  targetCleanupPending: boolean
}

export class AttachmentPreflightFailed extends Error {
  constructor(public readonly report: AttachmentPreflightReport) {
    super('Attachment preflight failed')
  }
}

export class StackAlreadyAttached extends Error {
  constructor(public readonly existingProjectRef: string) {
    super('The Supabase stack is already attached to another Fleet project')
  }
}

export class StackIdentityChanged extends Error {}

export class CapabilityUnavailable extends Error {
  constructor(
    public readonly capability: string,
    public readonly blockers: ProjectCapabilityRecord['blockers']
  ) {
    super(`Capability ${capability} is unavailable`)
  }
}

export class DetachOperationConflict extends Error {}

const identityRowSchema = z.object({
  system_identifier: z.coerce.string().min(1),
  timeline_id: z.coerce.string().min(1),
  database_oid: z.coerce.string().min(1),
  database_name: z.string().min(1),
  postgres_major: z.coerce.number().int().positive(),
  can_create_database_objects: z.boolean(),
  can_read_metadata: z.boolean(),
})

type ConnectionDocument = {
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_user_readonly: string
  db_pass_enc: string
  db_pass_readonly_enc: string | null
  kong_url: string
  rest_url: string
  anon_key_enc: string
  service_key_enc: string
  jwt_secret_enc: string | null
  publishable_key_enc: string | null
  secret_key_enc: string | null
  tls_mode: ProjectTlsMode
  tls_ca_reference: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildCandidateConnectionString(
  connection: Pick<
    AttachmentConnectionInput,
    'dbHost' | 'dbPort' | 'dbName' | 'dbUser' | 'dbPass' | 'tlsMode' | 'tlsCaReference'
  >
): string {
  const url = new URL('postgresql://localhost')
  url.hostname = connection.dbHost
  url.port = String(connection.dbPort)
  url.pathname = `/${encodeURIComponent(connection.dbName)}`
  url.username = connection.dbUser
  url.password = connection.dbPass
  url.searchParams.set('sslmode', connection.tlsMode)
  if (connection.tlsCaReference) {
    url.searchParams.set('sslrootcert', connection.tlsCaReference)
  }
  return url.toString()
}

async function queryCandidate<T>(
  connection: AttachmentConnectionInput,
  query: string
): Promise<T[]> {
  const serviceKey = connection.serviceKey || connection.secretKey || ''
  const response = await fetch(`${getProjectPgMetaBaseUrl(connection.kongUrl)}/query`, {
    method: 'POST',
    headers: {
      ...constructHeaders({
        'Content-Type': 'application/json',
        'x-connection-encrypted': encryptString(buildCandidateConnectionString(connection)),
      }),
      Authorization: `Bearer ${serviceKey}`,
      apiKey: serviceKey,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof body?.message === 'string'
        ? body.message
        : `Database probe returned HTTP ${response.status}`
    throw new Error(message)
  }
  if (!Array.isArray(body)) throw new Error('Database probe returned an invalid response')
  return body as T[]
}

async function probeHttp(input: {
  name: string
  url: string
  apiKey: string
  required: boolean
  acceptedStatuses?: number[]
  validateBody?: (body: unknown) => Record<string, unknown>
}): Promise<PreflightCheck> {
  try {
    const response = await fetch(input.url, {
      headers: { apikey: input.apiKey, Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    })
    const isAccepted = input.acceptedStatuses?.includes(response.status) ?? response.ok
    if (isAccepted) {
      let bodyEvidence: Record<string, unknown> = {}
      if (input.validateBody) {
        bodyEvidence = input.validateBody(await response.json())
      }
      return {
        name: input.name,
        status: 'pass',
        required: input.required,
        message: `${input.name} probe passed`,
        evidence: { status: response.status, ...bodyEvidence },
      }
    }
    return {
      name: input.name,
      status: input.required ? 'fail' : 'warning',
      required: input.required,
      message: `${input.name} probe returned HTTP ${response.status}`,
      remediation: `Verify the gateway route and credentials used for ${input.name}.`,
    }
  } catch (error) {
    return {
      name: input.name,
      status: input.required ? 'fail' : 'warning',
      required: input.required,
      message: `${input.name} probe failed: ${errorMessage(error)}`,
      remediation: `Verify that ${input.name} is reachable from the Studio server.`,
    }
  }
}

function keyModeCheck(connection: AttachmentConnectionInput): PreflightCheck {
  const hasLegacyKeys = Boolean(connection.anonKey && connection.serviceKey && connection.jwtSecret)
  const hasAsymmetricKeys = Boolean(connection.publishableKey && connection.secretKey)
  const valid =
    (connection.keyMode === 'legacy-jwt' && hasLegacyKeys) ||
    (connection.keyMode === 'asymmetric-jwks' && hasAsymmetricKeys && !connection.jwtSecret) ||
    (connection.keyMode === 'mixed' && hasLegacyKeys && hasAsymmetricKeys)
  return valid
    ? {
        name: 'key-mode',
        status: 'pass',
        required: true,
        message: `Credential set matches ${connection.keyMode}`,
      }
    : {
        name: 'key-mode',
        status: 'fail',
        required: true,
        message: `Credential set does not match ${connection.keyMode}`,
        remediation:
          connection.keyMode === 'asymmetric-jwks'
            ? 'Provide publishable and secret keys, and leave JWT secret empty.'
            : connection.keyMode === 'mixed'
              ? 'Provide legacy anon/service-role/JWT credentials and publishable/secret keys.'
              : 'Provide anon, service-role, and JWT secret credentials.',
      }
}

function capabilityFromCheck(
  name: string,
  check: PreflightCheck,
  observedAt: string,
  revision: string
): ProjectCapabilityRecord {
  const isAvailable = check.status === 'pass'
  return {
    name,
    state: isAvailable ? 'available' : 'unavailable',
    mode: 'direct',
    source: 'preflight',
    contractVersion: 'v1',
    targetVersion: null,
    observationRevision: revision,
    observedAt,
    validUntil: null,
    blockers: isAvailable
      ? []
      : [
          {
            code: 'preflight_failed',
            message: check.message,
            ...(check.remediation ? { remediation: check.remediation } : {}),
          },
        ],
  }
}

export function derivePreflightCapabilities(
  report: AttachmentPreflightReport
): ProjectCapabilityRecord[] {
  const byName = new Map(report.checks.map((check) => [check.name, check]))
  const observedAt = report.completedAt
  const revision = report.stackFingerprint ?? `failed:${report.completedAt}`
  const required = (name: string) => {
    const check = byName.get(name)
    if (!check) throw new Error(`Preflight report is missing ${name}`)
    return check
  }
  const capabilities: ProjectCapabilityRecord[] = [
    capabilityFromCheck(
      'database.metadata.read',
      required('metadata-permissions'),
      observedAt,
      revision
    ),
    capabilityFromCheck('auth.users.manage', required('auth'), observedAt, revision),
    capabilityFromCheck('storage.objects.manage', required('storage'), observedAt, revision),
    capabilityFromCheck('realtime.inspect', required('realtime'), observedAt, revision),
    {
      name: 'functions.read',
      state: report.outcome === 'pass' ? 'available' : 'unavailable',
      mode: 'direct',
      source: 'static-profile',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers:
        report.outcome === 'pass'
          ? []
          : [{ code: 'preflight_failed', message: 'Required attachment checks failed.' }],
    },
    {
      name: 'functions.deploy',
      state: 'unavailable',
      mode: 'agent',
      source: 'agent',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers: [
        {
          code: 'agent_capability_unavailable',
          message: 'Connect an Agent with the functions.deploy v1 capability.',
        },
      ],
    },
  ]
  for (const name of ['project.status.read', 'project.connection.update', 'project.detach']) {
    capabilities.push({
      name,
      state: report.outcome === 'pass' ? 'available' : 'unavailable',
      mode: 'direct',
      source: 'preflight',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers:
        report.outcome === 'pass'
          ? []
          : [{ code: 'preflight_failed', message: 'Required attachment checks failed.' }],
    })
  }
  capabilities.push(
    {
      name: 'management.target.bind',
      state: report.outcome === 'pass' ? 'available' : 'unavailable',
      mode: 'direct',
      source: 'static-profile',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers:
        report.outcome === 'pass'
          ? []
          : [{ code: 'preflight_failed', message: 'Required attachment checks failed.' }],
    },
    {
      name: 'management.agent.connect',
      state: 'unavailable',
      mode: 'agent',
      source: 'static-profile',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers: [
        {
          code: 'agent_not_enrolled',
          message: 'Issue a single-use enrollment token and enroll an Agent.',
        },
      ],
    },
    {
      name: 'management.enrollment.issue',
      state: 'unavailable',
      mode: 'operator',
      source: 'static-profile',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers: [
        {
          code: 'management_target_unbound',
          message: 'Bind the project to a management target before enrolling an Agent.',
        },
      ],
    },
    {
      name: 'management.certificate.revoke',
      state: 'unavailable',
      mode: 'operator',
      source: 'static-profile',
      contractVersion: 'v1',
      targetVersion: null,
      observationRevision: revision,
      observedAt,
      validUntil: null,
      blockers: [
        {
          code: 'agent_not_enrolled',
          message: 'Enroll an Agent before revoking its certificate.',
        },
      ],
    }
  )
  return capabilities
}

export async function findAttachedFingerprint(
  fingerprint: string,
  excludingProjectRef?: string
): Promise<string | null> {
  const parameters: unknown[] = [fingerprint]
  let exclusion = ''
  if (excludingProjectRef) {
    parameters.push(excludingProjectRef)
    exclusion = 'and project_ref <> $2'
  }
  const result = await executePlatformQuery<{ project_ref: string }>({
    query: `select project_ref from platform.stack_bindings
      where stack_fingerprint = $1 and attachment_state <> 'detached' ${exclusion}
      limit 1`,
    parameters,
  })
  if (result.error) throw result.error
  return result.data?.[0]?.project_ref ?? null
}

export async function runAttachmentPreflight(
  connection: AttachmentConnectionInput,
  options: { excludingProjectRef?: string } = {}
): Promise<AttachmentPreflightReport> {
  const startedAt = new Date().toISOString()
  const checks: PreflightCheck[] = [keyModeCheck(connection)]
  let fingerprint: string | null = null
  let identity: z.infer<typeof identityRowSchema> | undefined

  try {
    const rows = await queryCandidate<unknown>(
      connection,
      `select
         (pg_control_system()).system_identifier::text as system_identifier,
         (pg_control_checkpoint()).timeline_id::text as timeline_id,
         (select oid::text from pg_database where datname = current_database()) as database_oid,
         current_database() as database_name,
         current_setting('server_version_num')::integer / 10000 as postgres_major,
         has_database_privilege(current_user, current_database(), 'CREATE') as can_create_database_objects,
         has_schema_privilege(current_user, 'public', 'USAGE') as can_read_metadata`
    )
    identity = identityRowSchema.parse(rows[0])
    checks.push({
      name: 'database-connectivity',
      status: 'pass',
      required: true,
      message: 'Database connection and select probe passed',
    })
    checks.push({
      name: 'postgres-identity',
      status: 'pass',
      required: true,
      message: 'PostgreSQL identity evidence was verified',
      evidence: {
        systemIdentifier: identity.system_identifier,
        timelineId: identity.timeline_id,
        databaseOid: identity.database_oid,
        databaseName: identity.database_name,
        postgresMajor: identity.postgres_major,
      },
    })
    checks.push({
      name: 'metadata-permissions',
      status: identity.can_create_database_objects && identity.can_read_metadata ? 'pass' : 'fail',
      required: true,
      message:
        identity.can_create_database_objects && identity.can_read_metadata
          ? 'Required database metadata and DDL permissions are available'
          : 'The database identity lacks required metadata or DDL permissions',
      ...(!identity.can_create_database_objects || !identity.can_read_metadata
        ? {
            remediation:
              'Grant database CREATE and public schema USAGE to the Fleet database role.',
          }
        : {}),
    })
  } catch (error) {
    checks.push({
      name: 'database-connectivity',
      status: 'fail',
      required: true,
      message: `Database connection failed: ${errorMessage(error)}`,
      remediation: 'Verify DNS, TCP, TLS mode, database credentials, and pg_control_* access.',
    })
    checks.push({
      name: 'postgres-identity',
      status: 'fail',
      required: true,
      message: 'PostgreSQL identity could not be proved',
    })
    checks.push({
      name: 'metadata-permissions',
      status: 'fail',
      required: true,
      message: 'Database permissions could not be verified',
    })
  }

  const base = connection.kongUrl.replace(/\/$/, '')
  const adminKey =
    connection.keyMode === 'asymmetric-jwks' ? (connection.secretKey ?? '') : connection.serviceKey
  const [gateway, auth, rest, storage, realtime, jwks] = await Promise.all([
    probeHttp({
      name: 'gateway',
      url: `${base}/auth/v1/health`,
      apiKey: adminKey,
      required: true,
    }),
    probeHttp({ name: 'auth', url: `${base}/auth/v1/health`, apiKey: adminKey, required: true }),
    probeHttp({
      name: 'rest',
      url: connection.restUrl,
      apiKey: adminKey,
      required: true,
    }),
    probeHttp({
      name: 'storage',
      url: `${base}/storage/v1/status`,
      apiKey: adminKey,
      required: true,
    }),
    probeHttp({
      name: 'realtime',
      url: `${base}/realtime/v1/websocket`,
      apiKey: adminKey,
      required: false,
      acceptedStatuses: [200, 400, 401, 403, 404, 426],
    }),
    probeHttp({
      name: 'jwks',
      url: `${base}/auth/v1/.well-known/jwks.json`,
      apiKey: adminKey,
      required: connection.keyMode !== 'legacy-jwt',
      validateBody: (body) => {
        const parsed = z
          .object({ keys: z.array(z.object({ kid: z.string().min(1) })).min(1) })
          .parse(body)
        return { keyIds: parsed.keys.map(({ kid }) => kid) }
      },
    }),
  ])
  checks.push(gateway, auth, rest, storage, realtime, jwks)

  if (identity && gateway.status === 'pass' && auth.status === 'pass') {
    const gatewayOrigin = new URL(connection.kongUrl).origin
    fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          systemIdentifier: identity.system_identifier,
          gatewayOrigin,
          authIssuer: `${gatewayOrigin}/auth/v1`,
        })
      )
      .digest('hex')
    const existingProjectRef = await findAttachedFingerprint(
      fingerprint,
      options.excludingProjectRef
    )
    checks.push(
      existingProjectRef
        ? {
            name: 'stack-uniqueness',
            status: 'fail',
            required: true,
            message: 'This Supabase stack is already attached to another Fleet project',
            remediation: `Detach ${existingProjectRef} before attaching or perform an audited ownership transfer.`,
            evidence: { existingProjectRef },
          }
        : {
            name: 'stack-uniqueness',
            status: 'pass',
            required: true,
            message: 'No active Fleet project uses this stack fingerprint',
          }
    )
    checks.push({
      name: 'ownership-proof',
      status: 'pass',
      required: true,
      message: 'Database identity and service-role access prove stack control',
    })
  } else {
    checks.push({
      name: 'stack-uniqueness',
      status: 'fail',
      required: true,
      message: 'Stack uniqueness cannot be checked without identity evidence',
    })
    checks.push({
      name: 'ownership-proof',
      status: 'fail',
      required: true,
      message: 'Stack ownership could not be proved',
    })
  }

  const completedAt = new Date().toISOString()
  const outcome = checks.some((check) => check.required && check.status !== 'pass')
    ? 'fail'
    : 'pass'
  return {
    contractVersion: 'v1',
    startedAt,
    completedAt,
    outcome,
    stackFingerprint: fingerprint,
    checks,
  }
}

export function buildEncryptedConnectionDocument(
  connection: AttachmentConnectionInput
): ConnectionDocument {
  return {
    db_host: connection.dbHost,
    db_port: connection.dbPort,
    db_name: connection.dbName,
    db_user: connection.dbUser,
    db_user_readonly: connection.dbUserReadonly,
    db_pass_enc: encryptSecret(connection.dbPass),
    db_pass_readonly_enc: connection.dbPassReadonly
      ? encryptSecret(connection.dbPassReadonly)
      : null,
    kong_url: connection.kongUrl,
    rest_url: connection.restUrl,
    anon_key_enc: encryptSecret(connection.anonKey || connection.publishableKey || ''),
    service_key_enc: encryptSecret(connection.serviceKey || connection.secretKey || ''),
    jwt_secret_enc: connection.jwtSecret ? encryptSecret(connection.jwtSecret) : null,
    publishable_key_enc: connection.publishableKey
      ? encryptSecret(connection.publishableKey)
      : null,
    secret_key_enc: connection.secretKey ? encryptSecret(connection.secretKey) : null,
    tls_mode: connection.tlsMode,
    tls_ca_reference: connection.tlsCaReference,
  }
}

export function connectionFromProjectRow(row: {
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_user_readonly: string
  db_pass_enc: string
  db_pass_readonly_enc?: string | null
  kong_url: string
  rest_url: string
  anon_key_enc: string
  service_key_enc: string
  jwt_secret_enc: string | null
  publishable_key_enc: string | null
  secret_key_enc: string | null
  key_mode?: string
  tls_mode?: string
  tls_ca_reference?: string | null
  logflare_url?: string | null
  logflare_token_enc?: string | null
}): AttachmentConnectionInput {
  return {
    dbHost: row.db_host,
    dbPort: row.db_port,
    dbName: row.db_name,
    dbUser: row.db_user,
    dbUserReadonly: row.db_user_readonly,
    dbPass: decryptSecret(row.db_pass_enc),
    dbPassReadonly: row.db_pass_readonly_enc ? decryptSecret(row.db_pass_readonly_enc) : null,
    kongUrl: row.kong_url,
    restUrl: row.rest_url,
    anonKey: decryptSecret(row.anon_key_enc),
    serviceKey: decryptSecret(row.service_key_enc),
    jwtSecret: row.jwt_secret_enc ? decryptSecret(row.jwt_secret_enc) : '',
    publishableKey: row.publishable_key_enc ? decryptSecret(row.publishable_key_enc) : null,
    secretKey: row.secret_key_enc ? decryptSecret(row.secret_key_enc) : null,
    keyMode: KEY_MODES.includes(row.key_mode as ProjectKeyMode)
      ? (row.key_mode as ProjectKeyMode)
      : 'legacy-jwt',
    tlsMode: TLS_MODES.includes(row.tls_mode as ProjectTlsMode)
      ? (row.tls_mode as ProjectTlsMode)
      : 'prefer',
    tlsCaReference: row.tls_ca_reference ?? null,
    logflareUrl: row.logflare_url ?? null,
    logflareToken: row.logflare_token_enc ? decryptSecret(row.logflare_token_enc) : null,
  }
}

function capabilityRows(capabilities: ProjectCapabilityRecord[]) {
  return capabilities.map((capability) => ({
    name: capability.name,
    state: capability.state,
    mode: capability.mode,
    source: capability.source,
    contract_version: capability.contractVersion,
    target_version: capability.targetVersion,
    observation_revision: capability.observationRevision,
    observed_at: capability.observedAt,
    valid_until: capability.validUntil,
    blockers: capability.blockers,
  }))
}

export async function attachVerifiedProject(input: {
  ref: string
  name: string
  organizationId: number
  connection: AttachmentConnectionInput
  report: AttachmentPreflightReport
  actor: string
  correlationId: string
  containerName?: string | null
}): Promise<{ id: number; connectionRevision: number }> {
  if (input.report.outcome !== 'pass' || !input.report.stackFingerprint) {
    throw new AttachmentPreflightFailed(input.report)
  }
  const c = input.connection
  const document = buildEncryptedConnectionDocument(c)
  const capabilities = derivePreflightCapabilities(input.report)
  const result = await executePlatformQuery<{ id: number; connection_revision: number }>({
    query: `with project as (
        insert into platform.projects (
          ref, organization_id, name, status, cloud_provider, region,
          db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
          db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
          publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
          stack_kind, stack_meta, container_name, key_mode, tls_mode, tls_ca_reference,
          db_pass_readonly_enc
        ) values (
          $1, $2, $3, 'ACTIVE_HEALTHY', 'AWS', 'local',
          $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          'external', '{}'::jsonb, $19, $20, $21, $22, $29
        ) returning id
      ), revision as (
        insert into platform.project_connection_revisions (
          project_ref, revision, state, key_mode, connection_document,
          stack_fingerprint, preflight_report, created_by, correlation_id,
          validated_at, activated_at
        ) values ($1, 1, 'active', $20, $23::jsonb, $24, $25::jsonb, $26, $27, now(), now())
        returning revision
      ), binding as (
        insert into platform.stack_bindings (
          project_ref, stack_fingerprint, fingerprint_proof_state,
          active_connection_revision, key_mode, attachment_state,
          data_plane_health, management_connectivity, drift_state, operation_state,
          first_verified_at, last_verified_at, status_observed_at
        ) values ($1, $24, 'verified', 1, $20, 'active', 'healthy',
                  'unconfigured', 'unknown', 'idle', now(), now(), now())
      ), capabilities as (
        insert into platform.project_capabilities (
          project_ref, name, state, mode, source, contract_version, target_version,
          observation_revision, observed_at, valid_until, blockers
        ) select $1, item->>'name', item->>'state', item->>'mode', item->>'source',
                 item->>'contract_version', item->>'target_version',
                 item->>'observation_revision', (item->>'observed_at')::timestamptz,
                 nullif(item->>'valid_until', '')::timestamptz,
                 coalesce(item->'blockers', '[]'::jsonb)
          from jsonb_array_elements($28::jsonb) item
      ), audit as (
        insert into platform.audit_events (
          actor, project_ref, action, correlation_id, payload
        ) values ($26, $1, 'fleet.project.attach', $27,
          jsonb_build_object('stack_fingerprint', $24, 'connection_revision', 1, 'key_mode', $20))
      )
      select project.id, revision.revision as connection_revision from project cross join revision`,
    parameters: [
      input.ref,
      input.organizationId,
      input.name,
      c.dbHost,
      c.dbPort,
      c.dbName,
      c.dbUser,
      c.dbUserReadonly,
      c.kongUrl,
      c.restUrl,
      document.db_pass_enc,
      document.service_key_enc,
      document.anon_key_enc,
      document.jwt_secret_enc,
      document.publishable_key_enc,
      document.secret_key_enc,
      c.logflareUrl,
      c.logflareToken ? encryptSecret(c.logflareToken) : null,
      input.containerName ?? null,
      c.keyMode,
      c.tlsMode,
      c.tlsCaReference,
      JSON.stringify(document),
      input.report.stackFingerprint,
      JSON.stringify(input.report),
      input.actor,
      input.correlationId,
      JSON.stringify(capabilityRows(capabilities)),
      document.db_pass_readonly_enc,
    ],
  })
  if (result.error) {
    if (result.error.message.includes('stack_bindings_active_fingerprint_idx')) {
      const existing = await findAttachedFingerprint(input.report.stackFingerprint)
      throw new StackAlreadyAttached(existing ?? 'unknown')
    }
    throw result.error
  }
  const row = result.data?.[0]
  if (!row) throw new Error('Project attachment returned no row')
  return { id: row.id, connectionRevision: row.connection_revision }
}

export async function createConnectionCandidate(input: {
  projectRef: string
  keyMode: ProjectKeyMode
  connectionDocument: ConnectionDocument
  actor: string
  correlationId: string
}): Promise<{ id: number; revision: number }> {
  const result = await executePlatformQuery<{ id: number; revision: number }>({
    query: `with lock as (
        select pg_advisory_xact_lock(hashtextextended($1 || '/connection', 0))
      ), next_revision as (
        select coalesce(max(revision), 0) + 1 as revision
        from platform.project_connection_revisions where project_ref = $1
      )
      insert into platform.project_connection_revisions (
        project_ref, revision, state, key_mode, connection_document, created_by, correlation_id
      )
      select $1, next_revision.revision, 'validating', $2, $3::jsonb, $4, $5
      from next_revision cross join lock
      returning id, revision`,
    parameters: [
      input.projectRef,
      input.keyMode,
      JSON.stringify(input.connectionDocument),
      input.actor,
      input.correlationId,
    ],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  if (!row) throw new Error('Connection candidate returned no row')
  return row
}

export async function failConnectionCandidate(
  id: number,
  report: AttachmentPreflightReport
): Promise<void> {
  const result = await executePlatformQuery({
    query: `update platform.project_connection_revisions
      set state = 'failed', preflight_report = $2::jsonb, validated_at = now(),
          secrets_purge_after = now() + interval '7 days'
      where id = $1 and state = 'validating'`,
    parameters: [id, JSON.stringify(report)],
  })
  if (result.error) throw result.error
}

export async function activateConnectionCandidate(input: {
  id: number
  projectRef: string
  connection: AttachmentConnectionInput
  report: AttachmentPreflightReport
  actor: string
  correlationId: string
}): Promise<{ revision: number }> {
  if (input.report.outcome !== 'pass' || !input.report.stackFingerprint) {
    throw new AttachmentPreflightFailed(input.report)
  }
  const capabilities = derivePreflightCapabilities(input.report)
  const result = await executePlatformQuery<{ revision: number }>({
    query: `with eligible as (
        select candidate.id, active.revision as active_revision
        from platform.project_connection_revisions candidate
        join platform.project_connection_revisions active
          on active.project_ref = candidate.project_ref and active.state = 'active'
        where candidate.id = $1 and candidate.project_ref = $2
          and candidate.state = 'validating'
        for update of candidate, active
      ), previous as (
        update platform.project_connection_revisions revisions
        set state = 'rollback', rollback_until = now() + interval '24 hours'
        where revisions.project_ref = $2
          and revisions.revision = (select active_revision from eligible)
        returning revisions.revision
      ), candidate as (
        update platform.project_connection_revisions
        set state = 'active', stack_fingerprint = $3, preflight_report = $4::jsonb,
            validated_at = now(), activated_at = now()
        where id = (select id from eligible) and project_ref = $2 and state = 'validating'
          and exists (select 1 from previous)
        returning revision, connection_document, key_mode
      ), project_update as (
        update platform.projects p set
          db_host = candidate.connection_document->>'db_host',
          db_port = (candidate.connection_document->>'db_port')::integer,
          db_name = candidate.connection_document->>'db_name',
          db_user = candidate.connection_document->>'db_user',
          db_user_readonly = candidate.connection_document->>'db_user_readonly',
          db_pass_enc = candidate.connection_document->>'db_pass_enc',
          db_pass_readonly_enc = candidate.connection_document->>'db_pass_readonly_enc',
          kong_url = candidate.connection_document->>'kong_url',
          rest_url = candidate.connection_document->>'rest_url',
          anon_key_enc = candidate.connection_document->>'anon_key_enc',
          service_key_enc = candidate.connection_document->>'service_key_enc',
          jwt_secret_enc = candidate.connection_document->>'jwt_secret_enc',
          publishable_key_enc = candidate.connection_document->>'publishable_key_enc',
          secret_key_enc = candidate.connection_document->>'secret_key_enc',
          key_mode = candidate.key_mode,
          tls_mode = candidate.connection_document->>'tls_mode',
          tls_ca_reference = candidate.connection_document->>'tls_ca_reference',
          status = 'ACTIVE_HEALTHY', updated_at = now()
        from candidate where p.ref = $2
      ), binding as (
        update platform.stack_bindings b set
          stack_fingerprint = $3, fingerprint_proof_state = 'verified',
          active_connection_revision = candidate.revision, key_mode = candidate.key_mode,
          attachment_state = 'active', data_plane_health = 'healthy',
          first_verified_at = coalesce(b.first_verified_at, now()),
          last_verified_at = now(), status_observed_at = now()
        from candidate where b.project_ref = $2
      ), capabilities as (
        insert into platform.project_capabilities (
          project_ref, name, state, mode, source, contract_version, target_version,
          observation_revision, observed_at, valid_until, blockers
        ) select $2, item->>'name', item->>'state', item->>'mode', item->>'source',
                 item->>'contract_version', item->>'target_version',
                 item->>'observation_revision', (item->>'observed_at')::timestamptz,
                 nullif(item->>'valid_until', '')::timestamptz,
                 coalesce(item->'blockers', '[]'::jsonb)
          from jsonb_array_elements($7::jsonb) item
        on conflict (project_ref, name) do update set
          state = excluded.state, mode = excluded.mode, source = excluded.source,
          contract_version = excluded.contract_version, target_version = excluded.target_version,
          observation_revision = excluded.observation_revision, observed_at = excluded.observed_at,
          valid_until = excluded.valid_until, blockers = excluded.blockers
      ), audit as (
        insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
        select $5, $2, 'fleet.project.connection.activate', $6,
               jsonb_build_object('connection_revision', candidate.revision, 'stack_fingerprint', $3)
        from candidate
      )
      select revision from candidate`,
    parameters: [
      input.id,
      input.projectRef,
      input.report.stackFingerprint,
      JSON.stringify(input.report),
      input.actor,
      input.correlationId,
      JSON.stringify(capabilityRows(capabilities)),
    ],
  })
  if (result.error) {
    if (result.error.message.includes('stack_bindings_active_fingerprint_idx')) {
      const existing = await findAttachedFingerprint(
        input.report.stackFingerprint,
        input.projectRef
      )
      throw new StackAlreadyAttached(existing ?? 'unknown')
    }
    throw result.error
  }
  const row = result.data?.[0]
  if (!row) throw new Error('Connection candidate was superseded by another update')
  return row
}

export async function listProjectCapabilities(
  projectRef: string
): Promise<ProjectCapabilityRecord[]> {
  const result = await executePlatformQuery<{
    name: string
    state: ProjectCapabilityRecord['state']
    mode: ProjectCapabilityRecord['mode']
    source: ProjectCapabilityRecord['source']
    contract_version: string | null
    target_version: string | null
    observation_revision: string
    observed_at: string
    valid_until: string | null
    blockers: ProjectCapabilityRecord['blockers'] | null
  }>({
    query: `select name, state, mode, source, contract_version, target_version,
                   observation_revision, observed_at, valid_until, blockers
      from platform.project_capabilities where project_ref = $1 order by name`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return (result.data ?? []).map((row) =>
    projectCapabilityAt({
      name: row.name,
      state: row.state,
      mode: row.mode,
      source: row.source,
      contractVersion: row.contract_version,
      targetVersion: row.target_version,
      observationRevision: row.observation_revision,
      observedAt: row.observed_at,
      validUntil: row.valid_until,
      blockers: Array.isArray(row.blockers) ? row.blockers : [],
    })
  )
}

export async function requireProjectCapability(projectRef: string, name: string): Promise<void> {
  const capability = (await listProjectCapabilities(projectRef)).find((item) => item.name === name)
  if (!capability || capability.state !== 'available') {
    throw new CapabilityUnavailable(
      name,
      capability?.blockers ?? [
        {
          code: 'capability_unavailable',
          message: `Capability ${name} is not available.`,
        },
      ]
    )
  }
}

export async function getProjectAttachmentStatus(
  projectRef: string
): Promise<ProjectAttachmentStatus | null> {
  const result = await executePlatformQuery<{
    attachment_state: ProjectAttachmentStatus['attachmentState']
    data_plane_health: ProjectAttachmentStatus['dataPlaneHealth']
    management_connectivity: ProjectAttachmentStatus['managementConnectivity']
    agent_connectivity: ProjectAttachmentStatus['agentConnectivity']
    drift_state: ProjectAttachmentStatus['driftState']
    operation_state: ProjectAttachmentStatus['operationState']
    fingerprint_proof_state: ProjectAttachmentStatus['fingerprintProofState']
    key_mode: ProjectKeyMode
    active_connection_revision: number
    first_verified_at: string | null
    last_verified_at: string | null
    status_observed_at: string
    target_cleanup_pending: boolean
  }>({
    query: `select attachment_state, data_plane_health, management_connectivity, agent_connectivity,
                   drift_state, operation_state, fingerprint_proof_state, key_mode,
                   active_connection_revision, first_verified_at, last_verified_at,
                   status_observed_at, target_cleanup_pending
      from platform.stack_bindings where project_ref = $1`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  if (!row) return null
  return {
    attachmentState: row.attachment_state,
    dataPlaneHealth: row.data_plane_health,
    managementConnectivity: row.management_connectivity,
    targetConnectivity: row.management_connectivity,
    agentConnectivity: row.agent_connectivity,
    driftState: row.drift_state,
    operationState: row.operation_state,
    fingerprintProofState: row.fingerprint_proof_state,
    keyMode: row.key_mode,
    activeConnectionRevision: row.active_connection_revision,
    firstVerifiedAt: row.first_verified_at,
    lastVerifiedAt: row.last_verified_at,
    statusObservedAt: row.status_observed_at,
    targetCleanupPending: row.target_cleanup_pending,
  }
}

export async function detachProject(input: {
  projectRef: string
  actor: string
  correlationId?: string
}): Promise<{
  projectRef: string
  detachedAt: string
  targetCleanupPending: boolean
  infrastructureDeleted: false
}> {
  const result = await executePlatformQuery<{
    project_ref: string
    detached_at: string
    target_cleanup_pending: boolean
    infrastructure_deleted: false
  }>({
    query: `select * from platform.detach_project($1, $2, $3)`,
    parameters: [input.projectRef, input.actor, input.correlationId ?? randomUUID()],
  })
  if (result.error) {
    if (result.error.message.includes('operation_conflict')) {
      throw new DetachOperationConflict('Active operations must finish before detach')
    }
    throw result.error
  }
  const row = result.data?.[0]
  if (!row) throw new Error('Detach returned no row')
  return {
    projectRef: row.project_ref,
    detachedAt: row.detached_at,
    targetCleanupPending: row.target_cleanup_pending,
    infrastructureDeleted: false,
  }
}
