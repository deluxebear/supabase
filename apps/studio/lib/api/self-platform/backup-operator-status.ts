import {
  backupOperatorStatusSchema,
  unavailableBackupOperatorStatus,
  type BackupOperatorStatus,
} from './backup-operator-status.shared'
import { constructProjectPgMetaRequest } from './pg-meta'
import { ProjectNotFound, resolveProjectConnection } from './resolve-connection'
import type { ResolvedConnection } from './resolve-connection'

const QUERY_TIMEOUT_MS = 5_000
const STATUS_SQL = 'select status from _supabase_platform.backup_operator_status where id = 1'

export {
  backupOperatorStatusSchema,
  type BackupOperatorStatus,
  unavailableBackupOperatorStatus,
} from './backup-operator-status.shared'

async function queryStatus(connection: ResolvedConnection): Promise<unknown> {
  const target = constructProjectPgMetaRequest(connection, {}, { readOnly: true })
  const response = await fetch(`${target.baseUrl}/query`, {
    method: 'POST',
    headers: target.headers,
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
    const raw = await queryStatus(connection)
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
