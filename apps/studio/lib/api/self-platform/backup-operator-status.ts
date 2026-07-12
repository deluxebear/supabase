import { z } from 'zod'

import { ProjectNotFound, resolveProjectConnection } from './resolve-connection'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { PG_META_URL } from '@/lib/constants'

const QUERY_TIMEOUT_MS = 5_000
const STATUS_SQL = 'select status from _supabase_platform.backup_operator_status where id = 1'

export const backupOperatorStatusSchema = z.object({
  configured: z.boolean(),
  policy: z.object({
    enabled: z.boolean(),
    retentionDays: z.number().int().positive().nullable(),
    schedule: z.string().nullable(),
    backupFrom: z.enum(['primary', 'standby']).nullable(),
  }),
  provider: z.object({ name: z.string(), version: z.string().nullable() }),
  topology: z.object({
    kind: z.string(),
    primary: z.string().nullable(),
    standbys: z.number().int(),
  }),
  repository: z.object({ type: z.string().nullable(), location: z.string().nullable() }),
  check: z.object({
    status: z.enum(['healthy', 'degraded', 'unknown']),
    checkedAt: z.string().nullable(),
    message: z.string().nullable(),
  }),
  lastJob: z
    .object({ type: z.string(), state: z.string(), finishedAt: z.string().nullable() })
    .nullable(),
  capabilities: z.object({
    backup: z.boolean(),
    restore: z.boolean(),
    blockers: z.array(z.string()),
  }),
  compatibility: z.object({
    image: z.string().nullable(),
    supported: z.boolean(),
    blocker: z.string().nullable(),
  }),
  updatedAt: z.string().nullable(),
})

export type BackupOperatorStatus = z.infer<typeof backupOperatorStatusSchema>

export const unavailableBackupOperatorStatus: BackupOperatorStatus = {
  configured: false,
  policy: { enabled: false, retentionDays: null, schedule: null, backupFrom: null },
  provider: { name: 'pgBackRest', version: null },
  topology: { kind: 'unknown', primary: null, standbys: 0 },
  repository: { type: null, location: null },
  check: {
    status: 'unknown',
    checkedAt: null,
    message: 'No Backup Operator status has been published',
  },
  lastJob: null,
  capabilities: {
    backup: false,
    restore: false,
    blockers: ['Install and enroll the Backup Operator before enabling PITR'],
  },
  compatibility: {
    image: null,
    supported: false,
    blocker: 'Database image compatibility has not been verified',
  },
  updatedAt: null,
}

async function queryStatus(pgConnEncrypted: string): Promise<unknown> {
  const response = await fetch(`${PG_META_URL}/query`, {
    method: 'POST',
    headers: constructHeaders({
      'Content-Type': 'application/json',
      'x-connection-encrypted': pgConnEncrypted,
    }),
    body: JSON.stringify({ query: STATUS_SQL }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`pg-meta HTTP ${response.status}`)
  const rows = (await response.json()) as Record<string, unknown>[]
  return rows[0]?.status
}

export async function getBackupOperatorStatus(ref: string): Promise<BackupOperatorStatus> {
  try {
    const connection = await resolveProjectConnection(ref)
    const raw = await queryStatus(connection.pgConnReadOnlyEncrypted)
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return backupOperatorStatusSchema.parse(parsed)
  } catch (error) {
    if (error instanceof ProjectNotFound) throw error
    console.warn(
      `[self-platform] Backup Operator status unavailable for "${ref}": ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return unavailableBackupOperatorStatus
  }
}
