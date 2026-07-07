// [self-platform] F4 (Tier 2 observe): read operator-published pgBackRest
// status from the project DB and map it to the upstream BackupsResponse
// contract. Studio does not shell out or trigger backups — it observes a
// singleton status table an operator's backup cron populates with
// `pgbackrest info --output=json`. Absent/malformed → honest-empty response.
import type { paths } from 'api-types'

import { ProjectNotFound, resolveProjectConnection } from './resolve-connection'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { PG_META_URL } from '@/lib/constants'

type BackupsResponse =
  paths['/platform/database/{ref}/backups']['get']['responses']['200']['content']['application/json']

const PROJECT_QUERY_TIMEOUT_MS = 5_000

// Operator-owned singleton status table:
//   _supabase_platform.pgbackrest_info(id int pk default 1, info jsonb, updated_at)
// where `info` is the verbatim `pgbackrest info --output=json` array.
const STATUS_SQL = 'select info from _supabase_platform.pgbackrest_info where id = 1'

const EMPTY: BackupsResponse = {
  backups: [],
  physicalBackupData: {},
  pitr_enabled: false,
  region: 'local',
  walg_enabled: false,
}

// Only the fields we map from a `pgbackrest info --output=json` stanza element.
interface PgbackrestStanza {
  name?: string
  backup?: { label?: string; type?: string; timestamp?: { start?: number; stop?: number } }[]
  archive?: { id?: string; min?: string | null; max?: string | null }[]
}

async function queryProjectDb(
  pgConnEncrypted: string,
  query: string
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${PG_META_URL}/query`, {
    method: 'POST',
    headers: constructHeaders({
      'Content-Type': 'application/json',
      'x-connection-encrypted': pgConnEncrypted,
    }),
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(PROJECT_QUERY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`pg-meta HTTP ${response.status}`)
  return (await response.json()) as Record<string, unknown>[]
}

export function mapPgbackrestInfo(info: unknown): BackupsResponse {
  const stanzas: PgbackrestStanza[] = Array.isArray(info) ? (info as PgbackrestStanza[]) : []
  const backups: BackupsResponse['backups'] = []
  const starts: number[] = []
  let hasArchive = false

  for (const stanza of stanzas) {
    if (Array.isArray(stanza.archive) && stanza.archive.length > 0) hasArchive = true
    for (const b of stanza.backup ?? []) {
      const stop = b?.timestamp?.stop
      const start = b?.timestamp?.start
      if (typeof stop !== 'number') continue
      if (typeof start === 'number') starts.push(start)
      backups.push({
        // stop time is unique per backup; observe-only (UI keys on it, restore disabled).
        id: stop,
        inserted_at: new Date(stop * 1000).toISOString(),
        isPhysicalBackup: true,
        project_id: 0, // not consumed by the observe UI
        status: 'COMPLETED', // pgbackrest info only lists completed backups
      })
    }
  }

  if (backups.length === 0) return { ...EMPTY }

  return {
    backups,
    physicalBackupData: {
      earliestPhysicalBackupDateUnix: starts.length > 0 ? Math.min(...starts) : undefined,
      latestPhysicalBackupDateUnix: Math.max(...backups.map((b) => b.id)),
    },
    pitr_enabled: hasArchive,
    region: 'local',
    walg_enabled: false,
  }
}

export async function getProjectBackups(ref: string): Promise<BackupsResponse> {
  try {
    const conn = await resolveProjectConnection(ref)
    const rows = await queryProjectDb(conn.pgConnEncrypted, STATUS_SQL)
    const raw = rows[0]?.info
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return mapPgbackrestInfo(parsed)
  } catch (err) {
    if (err instanceof ProjectNotFound) throw err // route surfaces this as 404
    console.log(
      `[self-platform] backups observe degraded for "${ref}": ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { ...EMPTY }
  }
}
