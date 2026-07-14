import { createHash, createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { resolveProjectConnection } from './resolve-connection'

const REQUEST_TIMEOUT_MS = 10_000
const nullableStringArraySchema = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? [])

export const backupPolicySchema = z.object({
  id: z.string().optional(),
  enabled: z.boolean(),
  repositoryId: z.string().default(''),
  retentionDays: z.number().int().positive(),
  fullSchedule: z.string(),
  diffSchedule: z.string().nullable(),
  incrSchedule: z.string().nullable(),
  backupFrom: z.enum(['primary', 'standby']),
  designatedStandby: z.string().nullable(),
  maxStandbyLagBytes: z.number().int().nonnegative().default(0),
  nextRunAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable(),
})

export const operatorClusterSchema = z.object({
  projectId: z.string(),
  targetId: z.string(),
  systemIdentifier: z.string(),
  dataDomain: z.string(),
  createdAt: z.string().nullable().optional(),
  discovery: z
    .object({
      provider: z.string(),
      providerVersion: z.string().optional(),
      topology: z.string(),
      primary: z.string().optional(),
      standbys: nullableStringArraySchema,
      repositoryId: z.string().optional(),
      repositoryType: z.string().optional(),
      repositoryLocation: z.string().optional(),
      blockers: nullableStringArraySchema,
      observedAt: z.string(),
    })
    .nullable(),
})

export const operatorPITRSchema = z.object({
  enabled: z.boolean(),
  healthy: z.boolean(),
  archiveCommand: z.string().optional(),
  repositoryId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  blockers: nullableStringArraySchema,
})

export const operatorBackupSchema = z.object({
  id: z.string(),
  type: z.enum(['full', 'diff', 'incr']),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  recoverableUntil: z.string().nullable(),
})

export const operatorBackupsSchema = z.object({
  backups: z.array(operatorBackupSchema),
  recoveryWindow: z.object({ earliest: z.string().nullable(), latest: z.string().nullable() }),
  confidence: z.enum(['unknown', 'inferred', 'drill-verified']),
  isStale: z.boolean(),
  blockers: nullableStringArraySchema,
  drill: z
    .object({
      id: z.string(),
      targetTime: z.string(),
      completedAt: z.string(),
      passed: z.boolean(),
      evidenceDigest: z.string().nullable(),
    })
    .nullable(),
})

export const restorePlanSchema = z.object({
  id: z.string(),
  hash: z.string(),
  expiresAt: z.string(),
  recoveryTarget: z.string(),
  impact: z.object({
    serviceInterruption: z.string(),
    affectedNodes: z.array(z.string()),
    requiredBytes: z.number().nonnegative(),
  }),
  blockers: z.array(z.string()),
})

export const operatorJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  state: z.enum([
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'orphaned',
    'manual-intervention',
    'rollback-available',
  ]),
  progress: z.number().min(0).max(100),
  updatedAt: z.string(),
  rollbackUntil: z.string().nullable(),
  manualIntervention: z
    .object({
      code: z.string(),
      summary: z.string(),
      safeAction: z.string(),
      runbookUrl: z.string(),
    })
    .nullable(),
})

export class BackupOperatorAPIError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly metadata: {
      correlationId?: string
      retryable?: boolean
      details?: unknown
    } = {}
  ) {
    super(message)
    this.name = 'BackupOperatorAPIError'
  }
}

function errorCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  return 'UNAVAILABLE'
}

const encodeJWTPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export function mintBackupOperatorServiceAssertion({
  key,
  issuer,
  audience,
  subject,
  project,
  aal,
  aalAuthenticatedAt,
  ttlSeconds = 60,
}: {
  key: string
  issuer: string
  audience: string
  subject: string
  project: string
  aal?: string
  aalAuthenticatedAt?: number
  ttlSeconds?: number
}) {
  if (Buffer.byteLength(key) < 32 || !issuer || !audience || !subject || !project) {
    throw new Error('Backup Operator service assertion configuration is incomplete')
  }
  const ttl = Math.max(15, Math.min(ttlSeconds, 300))
  const now = Math.floor(Date.now() / 1000)
  const header = encodeJWTPart({ alg: 'HS256', typ: 'JWT' })
  const payload = encodeJWTPart({
    iss: issuer,
    sub: subject,
    aud: audience,
    nbf: now - 5,
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
    scopes: ['backup.read', 'backup.write', 'restore.execute'],
    roles: ['studio'],
    projects: [project],
    ...(aal === 'aal2' &&
    typeof aalAuthenticatedAt === 'number' &&
    Number.isSafeInteger(aalAuthenticatedAt) &&
    aalAuthenticatedAt > 0
      ? { aal: 'aal2', aal_authenticated_at: aalAuthenticatedAt }
      : {}),
  })
  const signature = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

export async function resolveBackupOperatorTarget(projectRef: string) {
  const connection = await resolveProjectConnection(projectRef)
  const configuredClusterId = connection.row?.stack_meta?.backupOperatorClusterId
  return {
    clusterId:
      typeof configuredClusterId === 'string' && configuredClusterId.length > 0
        ? configuredClusterId
        : projectRef,
    operatorUrl: process.env.BACKUP_OPERATOR_URL,
  }
}

export async function requestBackupOperator(
  projectRef: string,
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT'
    body?: unknown
    actor?: string
    aal?: string
    aalAuthenticatedAt?: number
    correlationId?: string
    idempotencyKey?: string
    onResponse?: (metadata: { correlationId?: string }) => void
  } = {}
) {
  const { clusterId, operatorUrl } = await resolveBackupOperatorTarget(projectRef)
  const assertionKey = process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_KEY
  const assertionIssuer = process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_ISSUER ?? 'supabase-studio'
  const assertionAudience =
    process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_AUDIENCE ?? 'backup-operator'
  if (!operatorUrl || !assertionKey) {
    throw new BackupOperatorAPIError(
      'UNAVAILABLE',
      'The Backup Operator endpoint or service assertion key is not configured',
      503
    )
  }
  const correlationId = init.correlationId ?? randomUUID()
  const actor = init.actor || 'studio-api'
  const assertion = mintBackupOperatorServiceAssertion({
    key: assertionKey,
    issuer: assertionIssuer,
    audience: assertionAudience,
    subject: actor,
    project: clusterId,
    aal: init.aal,
    aalAuthenticatedAt: init.aalAuthenticatedAt,
  })
  const operatorPath = path.startsWith('/operations/')
    ? `/v1${path}`
    : `/v1/clusters/${encodeURIComponent(clusterId)}${path}`
  const response = await fetch(`${operatorUrl.replace(/\/$/, '')}${operatorPath}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${assertion}`,
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId,
      'X-Audit-Context': JSON.stringify({ actor, aal: init.aal ?? 'unknown', source: 'studio' }),
      ...(init.method && init.method !== 'GET'
        ? {
            'Idempotency-Key':
              init.idempotencyKey ??
              createHash('sha256')
                .update(`${projectRef}\n${path}\n${JSON.stringify(init.body ?? null)}`)
                .digest('hex'),
          }
        : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const responseCorrelationId = response.headers.get('x-correlation-id') ?? correlationId
  init.onResponse?.({ correlationId: responseCorrelationId })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Backup Operator returned HTTP ${response.status}`
    const upstreamCode =
      payload && typeof payload === 'object' && 'code' in payload
        ? String(payload.code)
        : errorCode(response.status)
    const upstreamCorrelation =
      payload && typeof payload === 'object' && 'correlation_id' in payload
        ? String(payload.correlation_id)
        : responseCorrelationId
    throw new BackupOperatorAPIError(upstreamCode, message, response.status, {
      correlationId: upstreamCorrelation,
      retryable:
        payload && typeof payload === 'object' && 'retryable' in payload
          ? Boolean(payload.retryable)
          : response.status === 429 || response.status >= 500,
      details:
        payload && typeof payload === 'object' && 'details' in payload
          ? payload.details
          : undefined,
    })
  }
  return response.status === 204 ? null : response.json()
}

export async function requestBackupOperatorEvents(
  projectRef: string,
  operationId: string,
  cursor: number,
  init: {
    actor?: string
    aal?: string
    aalAuthenticatedAt?: number
    correlationId?: string
    onResponse?: (metadata: { correlationId?: string }) => void
  } = {}
) {
  const { clusterId, operatorUrl } = await resolveBackupOperatorTarget(projectRef)
  const assertionKey = process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_KEY
  const assertionIssuer = process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_ISSUER ?? 'supabase-studio'
  const assertionAudience =
    process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_AUDIENCE ?? 'backup-operator'
  if (!operatorUrl || !assertionKey) {
    throw new BackupOperatorAPIError(
      'UNAVAILABLE',
      'The Backup Operator endpoint or service assertion key is not configured',
      503
    )
  }
  const correlationId = init.correlationId ?? randomUUID()
  const actor = init.actor || 'studio-api'
  const assertion = mintBackupOperatorServiceAssertion({
    key: assertionKey,
    issuer: assertionIssuer,
    audience: assertionAudience,
    subject: actor,
    project: clusterId,
    aal: init.aal,
    aalAuthenticatedAt: init.aalAuthenticatedAt,
  })
  const url = new URL(
    `/v1/operations/${encodeURIComponent(operationId)}/events`,
    `${operatorUrl.replace(/\/$/, '')}/`
  )
  url.searchParams.set('cursor', String(cursor))
  const response = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${assertion}`,
      'X-Correlation-ID': correlationId,
      'X-Audit-Context': JSON.stringify({ actor, aal: init.aal ?? 'unknown', source: 'studio' }),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const responseCorrelationId = response.headers.get('x-correlation-id') ?? correlationId
  init.onResponse?.({ correlationId: responseCorrelationId })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new BackupOperatorAPIError(
      payload && typeof payload === 'object' && 'code' in payload
        ? String(payload.code)
        : errorCode(response.status),
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Backup Operator returned HTTP ${response.status}`,
      response.status,
      {
        correlationId:
          payload && typeof payload === 'object' && 'correlation_id' in payload
            ? String(payload.correlation_id)
            : responseCorrelationId,
        retryable:
          payload && typeof payload === 'object' && 'retryable' in payload
            ? Boolean(payload.retryable)
            : response.status === 429 || response.status >= 500,
        details:
          payload && typeof payload === 'object' && 'details' in payload
            ? payload.details
            : undefined,
      }
    )
  }
  return {
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? 'text/event-stream',
  }
}
