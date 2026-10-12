import { z } from 'zod'

import { encryptString } from '../self-hosted/util'
import { buildCandidateConnectionString } from './attachment'
import { constructProjectPgMetaRequest } from './pg-meta'
import { resolveProjectConnection } from './resolve-connection'
import { decryptSecret } from './secrets'

// [self-platform] Supavisor keeps its settings in the `_supabase` catalog
// database, which the Fleet Agent also reads and writes. Until Fleet has applied
// a policy, Studio shows these running values instead of its column defaults.
const tenantSchema = z.object({
  default_pool_size: z.coerce.number().int(),
  default_max_clients: z.coerce.number().int(),
  allow_list: z.array(z.string()).nullable(),
})

export type LiveDatabaseSecurity = {
  network: { allowedCidrs: string[] }
  pooler: { defaultPoolSize: number; maxClientConnections: number }
}

export function mapSupavisorTenant(raw: unknown): LiveDatabaseSecurity | null {
  const parsed = tenantSchema.safeParse(raw)
  if (!parsed.success) return null
  const cidrs = parsed.data.allow_list ?? []
  // The Agent writes "allow all" as these two networks; the policy shows it as empty.
  const isAllowAll = cidrs.length === 2 && cidrs[0] === '0.0.0.0/0' && cidrs[1] === '::/0'
  return {
    network: { allowedCidrs: isAllowAll ? [] : cidrs },
    pooler: {
      defaultPoolSize: parsed.data.default_pool_size,
      maxClientConnections: parsed.data.default_max_clients,
    },
  }
}

/** Running Supavisor settings, or null when they cannot be read. */
export async function readLiveDatabaseSecurity(
  projectRef: string,
  fetchImpl: typeof fetch = fetch
): Promise<LiveDatabaseSecurity | null> {
  try {
    const connection = await resolveProjectConnection(projectRef)
    const row = connection.row
    if (!row) return null
    const catalogDsn = buildCandidateConnectionString({
      dbHost: row.db_host,
      dbPort: row.db_port,
      dbName: '_supabase',
      dbUser: row.db_user,
      dbPass: decryptSecret(row.db_pass_enc),
      tlsMode: row.tls_mode ?? 'prefer',
      tlsCaReference: row.tls_ca_reference ?? null,
    })
    const target = constructProjectPgMetaRequest({
      ...connection,
      pgConnEncrypted: encryptString(catalogDsn),
    })
    const response = await fetchImpl(`${target.baseUrl}/query`, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify({
        query:
          'select default_pool_size, default_max_clients, allow_list from _supavisor.tenants order by inserted_at limit 1',
      }),
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return null
    const rows: unknown = await response.json()
    return Array.isArray(rows) ? mapSupavisorTenant(rows[0]) : null
  } catch {
    return null
  }
}
