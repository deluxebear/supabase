// [self-platform] F9+F16 M5.0: project provisioning admin operations —
// quick-create (database on a registered host stack), attach-external
// (register an independent stack with a connectivity probe), and
// deregister-with-GC. Read paths stay in projects.ts; this module owns the
// mutations. Spec: docs/self-hosted-parity/2026-07-05-F9-F16-M5.0-provisioning-design.md
import { executePlatformQuery } from './db'
import { getProjectByRef } from './projects'
import { encryptSecret } from './secrets'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { executeQuery } from '@/lib/api/self-hosted/query'
import { encryptString } from '@/lib/api/self-hosted/util'
import { PG_META_URL } from '@/lib/constants'

export const REF_PATTERN = /^[a-z][a-z0-9-]{2,29}$/
export const RESERVED_REFS = new Set(['default'])

export function refToDbName(ref: string): string {
  return ref.replace(/-/g, '_')
}

export class DuplicateRef extends Error {}
export class InvalidHostStack extends Error {}
export class ProbeFailed extends Error {}

export interface ExternalConnectionInput {
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  dbUserReadonly: string
  dbPass: string
  kongUrl: string
  restUrl: string
  anonKey: string
  serviceKey: string
  jwtSecret: string
  publishableKey?: string | null
  secretKey?: string | null
  logflareUrl?: string | null
  logflareToken?: string | null
}

const REQUIRED_CONNECTION_FIELDS = [
  'dbHost',
  'dbPass',
  'kongUrl',
  'anonKey',
  'serviceKey',
  'jwtSecret',
] as const

// Mirrors the register CLI's REQUIRED_INPUT_FIELDS guard: never register an
// empty-secret project. Optional fields get the CLI's defaults.
export function parseExternalConnectionInput(
  raw: unknown
): { value: ExternalConnectionInput } | { error: string } {
  const obj = (raw ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '')
  const missing = REQUIRED_CONNECTION_FIELDS.filter((k) => str(k) === '')
  if (missing.length) {
    return { error: `Missing required connection field(s): ${missing.join(', ')}` }
  }
  const kongUrl = str('kongUrl')
  const port = obj.dbPort === undefined ? 5432 : Number(obj.dbPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'Invalid dbPort' }
  }
  return {
    value: {
      dbHost: str('dbHost'),
      dbPort: port,
      dbName: str('dbName') || 'postgres',
      dbUser: str('dbUser') || 'supabase_admin',
      dbUserReadonly: str('dbUserReadonly') || 'supabase_read_only_user',
      dbPass: str('dbPass'),
      kongUrl,
      restUrl: str('restUrl') || kongUrl.replace(/\/$/, '') + '/rest/v1/',
      anonKey: str('anonKey'),
      serviceKey: str('serviceKey'),
      jwtSecret: str('jwtSecret'),
      publishableKey: str('publishableKey') || null,
      secretKey: str('secretKey') || null,
      logflareUrl: str('logflareUrl') || null,
      logflareToken: str('logflareToken') || null,
    },
  }
}

// [self-platform] Probe an EXPLICIT candidate DSN through the same pg-meta
// proxy channel executeQuery/executePlatformQuery use (the encrypted DSN
// header IS the connection) — the candidate is not in the registry yet, so
// executeQuery (registry-bound via projectRef) cannot do this. No new
// database driver dependency.
export async function probeConnection(
  c: Pick<ExternalConnectionInput, 'dbHost' | 'dbPort' | 'dbName' | 'dbUser' | 'dbPass'>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dsn = `postgresql://${c.dbUser}:${c.dbPass}@${c.dbHost}:${c.dbPort}/${c.dbName}`
  try {
    const response = await fetch(`${PG_META_URL}/query`, {
      method: 'POST',
      headers: constructHeaders({
        'Content-Type': 'application/json',
        'x-connection-encrypted': encryptString(dsn),
      }),
      body: JSON.stringify({ query: 'select 1' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      let message = `probe failed with status ${response.status}`
      try {
        const body = await response.json()
        if (typeof body?.message === 'string') message = body.message
      } catch {
        // non-JSON error body — keep the status message
      }
      return { ok: false, error: message }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const INSERT_COLUMNS = `ref, organization_id, name, status, cloud_provider, region,
   db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
   db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
   publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
   stack_kind, stack_meta`

function isDuplicateKey(error: Error): boolean {
  return error.message.includes('duplicate key value violates unique constraint')
}

export async function createSharedDbProject(input: {
  ref: string
  name: string
  hostRef: string
  organizationId: number
}): Promise<{ id: number }> {
  if (!REF_PATTERN.test(input.ref) || RESERVED_REFS.has(input.ref)) {
    throw new Error(`invalid project ref "${input.ref}"`)
  }

  const host = await getProjectByRef(input.hostRef)
  if (!host || host.stack_kind !== 'external') {
    throw new InvalidHostStack(`Host stack "${input.hostRef}" is not a registered external stack`)
  }
  const dbName = refToDbName(input.ref)

  // Insert-first (spec §4): the ref UNIQUE constraint is the race-free
  // concurrency gate, and a crash after insert leaves a visible COMING_UP row
  // the user can remove via the delete endpoint. Credential ciphertexts are
  // cloned verbatim (same at-rest key). logflare columns are NOT cloned —
  // per-ref analytics stays honestly "not configured" (M2.1 no-fallback).
  const insert = await executePlatformQuery<{ id: number }>({
    query: `insert into platform.projects
      (${INSERT_COLUMNS})
      values ($1,$2,$3,'COMING_UP',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              null, null, 'shared-db', $19::jsonb)
      returning id`,
    parameters: [
      input.ref,
      input.organizationId,
      input.name,
      host.cloud_provider,
      host.region,
      host.db_host,
      host.db_port,
      dbName,
      host.db_user,
      host.db_user_readonly,
      host.kong_url,
      host.rest_url,
      host.db_pass_enc,
      host.service_key_enc,
      host.anon_key_enc,
      host.jwt_secret_enc,
      host.publishable_key_enc,
      host.secret_key_enc,
      JSON.stringify({ host_ref: input.hostRef }),
    ],
  })
  if (insert.error) {
    if (isDuplicateKey(insert.error)) throw new DuplicateRef(input.ref)
    throw insert.error
  }
  const id = insert.data?.[0]?.id
  if (id === undefined) throw new Error('project insert returned no id')

  // CREATE DATABASE runs as a single autocommit statement through the host
  // project's pg-meta connection (Task 2 spike). The identifier cannot be
  // parameterized — REF_PATTERN validation + hyphen→underscore mapping is
  // the injection barrier. The guard is enforced in-module at the top of this
  // function AND at the route layer; double quotes pin the identifier.
  const ddl = await executeQuery({
    query: `create database "${dbName}"`,
    projectRef: input.hostRef,
  })
  if (ddl.error) {
    await executePlatformQuery({
      query: 'delete from platform.projects where ref = $1',
      parameters: [input.ref],
    })
    throw new Error(`CREATE DATABASE failed: ${ddl.error.message}`)
  }

  const flip = await executePlatformQuery({
    query: `update platform.projects set status = 'ACTIVE_HEALTHY', updated_at = now() where ref = $1`,
    parameters: [input.ref],
  })
  if (flip.error) throw flip.error
  return { id }
}

export async function attachExternalProject(input: {
  ref: string
  name: string
  organizationId: number
  connection: ExternalConnectionInput
}): Promise<{ id: number }> {
  const c = input.connection
  const probe = await probeConnection(c)
  if (!probe.ok) throw new ProbeFailed(probe.error)

  const insert = await executePlatformQuery<{ id: number }>({
    query: `insert into platform.projects
      (${INSERT_COLUMNS})
      values ($1,$2,$3,'ACTIVE_HEALTHY','AWS','local',$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,'external','{}'::jsonb)
      returning id`,
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
      encryptSecret(c.dbPass),
      encryptSecret(c.serviceKey),
      encryptSecret(c.anonKey),
      encryptSecret(c.jwtSecret),
      c.publishableKey ? encryptSecret(c.publishableKey) : null,
      c.secretKey ? encryptSecret(c.secretKey) : null,
      c.logflareUrl ?? null,
      c.logflareToken ? encryptSecret(c.logflareToken) : null,
    ],
  })
  if (insert.error) {
    if (isDuplicateKey(insert.error)) throw new DuplicateRef(input.ref)
    throw insert.error
  }
  const id = insert.data?.[0]?.id
  if (id === undefined) throw new Error('project insert returned no id')
  return { id }
}

export async function deleteProjectByRef(ref: string): Promise<boolean> {
  const del = await executePlatformQuery<{ id: number }>({
    query: 'delete from platform.projects where ref = $1 returning id',
    parameters: [ref],
  })
  if (del.error) throw del.error
  if ((del.data ?? []).length === 0) return false

  // GC derived roles orphaned by the role_projects FK cascade above. This
  // MUST be a second statement: a CTE attached to the delete would read the
  // pre-statement snapshot and never see the cascade (M1 I1-BUG class).
  // Predicate matches M3.1's derived-role discriminator (base_role_id <> id);
  // org-scoped roles (base_role_id = id) never have role_projects rows and
  // are structurally excluded. Crash window between the two statements
  // leaves a ZERO-GRANT orphan derived role (fail-closed via M3.1 I1 guards).
  const gc = await executePlatformQuery({
    query: `delete from platform.roles r
      where r.base_role_id <> r.id
        and not exists (select 1 from platform.role_projects rp where rp.role_id = r.id)`,
  })
  if (gc.error) throw gc.error
  return true
}
