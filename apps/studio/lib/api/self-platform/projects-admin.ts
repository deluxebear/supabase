// [self-platform] F9+F16 M5.0: project provisioning admin operations —
// quick-create (database on a registered host stack), attach-external
// (register an independent stack with a connectivity probe), and
// deregister-with-GC. Read paths stay in projects.ts; this module owns the
// mutations. Spec: docs/self-hosted-parity/2026-07-05-F9-F16-M5.0-provisioning-design.md
import { executePlatformQuery } from './db'
import { getProjectByRef } from './projects'
import { decryptSecret, encryptSecret } from './secrets'
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
export class CreateDatabaseFailed extends Error {}

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
  // [self-platform] M5.0 final review: host must belong to the caller's org —
  // cross-org hosting would clone another org's gateway/key ciphertexts.
  if (host.organization_id !== input.organizationId) {
    throw new InvalidHostStack(`Host stack "${input.hostRef}" belongs to a different organization`)
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
    const cleanup = await executePlatformQuery({
      query: 'delete from platform.projects where ref = $1',
      parameters: [input.ref],
    })
    if (cleanup.error) {
      console.warn(
        `[self-platform] failed to clean up COMING_UP row for "${input.ref}" after CREATE DATABASE failure: ${cleanup.error.message} — remove it via DELETE /platform/projects/${input.ref}`
      )
    }
    throw new CreateDatabaseFailed(`CREATE DATABASE failed: ${ddl.error.message}`)
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
  if (RESERVED_REFS.has(ref)) {
    throw new Error(`refusing to deregister reserved ref "${ref}"`)
  }

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

// ————————————————————————————————————————————————————————————————————————
// [self-platform] M6.1: connection-config edit (spec §3/§4).
// Spec: docs/self-hosted-parity/2026-07-05-M6.1-connection-config-design.md

export class SharedDbLocked extends Error {}
export class ProjectRowMissing extends Error {}

export interface ConnectionPatch {
  dbHost?: string
  dbPort?: number
  dbName?: string
  dbUser?: string
  dbUserReadonly?: string
  kongUrl?: string
  restUrl?: string
  dbPass?: string
  anonKey?: string
  serviceKey?: string
  jwtSecret?: string
  publishableKey?: string | null
  secretKey?: string | null
}

export interface ProjectPatch {
  name?: string
  connection?: ConnectionPatch
  logflareUrl?: string | null
  logflareToken?: string | null
}

const IMMUTABLE_FIELDS = ['ref', 'stack_kind', 'stack_meta'] as const
const NON_SECRET_CONNECTION_FIELDS = [
  'dbHost',
  'dbName',
  'dbUser',
  'dbUserReadonly',
  'kongUrl',
  'restUrl',
] as const
const REQUIRED_SECRET_FIELDS = ['dbPass', 'anonKey', 'serviceKey', 'jwtSecret'] as const
const NULLABLE_SECRET_FIELDS = ['publishableKey', 'secretKey'] as const

// Semantics (spec D2/D5): immutable trio → error BY NAME; unknown keys are
// dropped (auth-config whitelist precedent — the upstream rename form may
// send cloud-only fields); secrets ''/absent = keep (M4 mask round-trip),
// null = clear (nullable fields only); everything trimmed (attach-parser
// parity). Values are normalized so downstream code only ever sees
// effective operations.
export function parseProjectPatchInput(raw: unknown): { value: ProjectPatch } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Request body must be a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  for (const field of IMMUTABLE_FIELDS) {
    if (field in obj) return { error: `Field "${field}" cannot be changed` }
  }

  const value: ProjectPatch = {}

  if (obj.name !== undefined) {
    if (typeof obj.name !== 'string' || obj.name.trim() === '' || obj.name.trim().length > 64) {
      return { error: 'Invalid name: must be a non-empty string of at most 64 characters' }
    }
    value.name = obj.name.trim()
  }

  if (obj.connection !== undefined) {
    if (
      obj.connection === null ||
      typeof obj.connection !== 'object' ||
      Array.isArray(obj.connection)
    ) {
      return { error: 'Invalid connection: must be an object' }
    }
    const c = obj.connection as Record<string, unknown>
    for (const field of IMMUTABLE_FIELDS) {
      if (field in c) return { error: `Field "${field}" cannot be changed` }
    }
    const conn: ConnectionPatch = {}
    for (const key of NON_SECRET_CONNECTION_FIELDS) {
      const v = c[key]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.trim() === '') {
        return { error: `Invalid ${key}: must be a non-empty string` }
      }
      conn[key] = v.trim()
    }
    if (c.dbPort !== undefined) {
      const port = Number(c.dbPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Invalid dbPort' }
      conn.dbPort = port
    }
    for (const key of REQUIRED_SECRET_FIELDS) {
      const v = c[key]
      if (v === undefined) continue
      if (v === null) return { error: `Field "${key}" cannot be cleared` }
      if (typeof v !== 'string') return { error: `Invalid ${key}` }
      if (v.trim() === '') continue // mask round-trip: keep stored value
      conn[key] = v.trim()
    }
    for (const key of NULLABLE_SECRET_FIELDS) {
      const v = c[key]
      if (v === undefined) continue
      if (v === null) {
        conn[key] = null
        continue
      }
      if (typeof v !== 'string') return { error: `Invalid ${key}` }
      if (v.trim() === '') continue // keep
      conn[key] = v.trim()
    }
    if (Object.keys(conn).length > 0) value.connection = conn
  }

  if (obj.logflare !== undefined) {
    if (obj.logflare === null || typeof obj.logflare !== 'object' || Array.isArray(obj.logflare)) {
      return { error: 'Invalid logflare: must be an object' }
    }
    const lf = obj.logflare as Record<string, unknown>
    for (const field of IMMUTABLE_FIELDS) {
      if (field in lf) return { error: `Field "${field}" cannot be changed` }
    }
    for (const [key, prop] of [
      ['url', 'logflareUrl'],
      ['token', 'logflareToken'],
    ] as const) {
      const v = lf[key]
      if (v === undefined) continue
      if (v === null) {
        value[prop] = null
        continue
      }
      if (typeof v !== 'string') return { error: `Invalid logflare.${key}` }
      if (v.trim() === '') continue // keep
      value[prop] = v.trim()
    }
  }

  if (
    value.name === undefined &&
    value.connection === undefined &&
    value.logflareUrl === undefined &&
    value.logflareToken === undefined
  ) {
    return { error: 'No editable fields in request body' }
  }
  return { value }
}

// Cloned-field set (spec D7): everything a quick-create clones from its host
// EXCEPT db_name (each child connects to its own database). name/logflare are
// per-row and never propagate either.
const PROPAGATED_CONNECTION_KEYS: ReadonlyArray<keyof ConnectionPatch> = [
  'dbHost',
  'dbPort',
  'dbUser',
  'dbUserReadonly',
  'kongUrl',
  'restUrl',
  'dbPass',
  'anonKey',
  'serviceKey',
  'jwtSecret',
  'publishableKey',
  'secretKey',
]

export async function updateProjectConnection(
  ref: string,
  patch: ProjectPatch
): Promise<{ propagatedChildren: string[] }> {
  const row = await getProjectByRef(ref)
  if (!row) {
    // The route guard 404s ghosts before this runs; this branch covers the
    // env-fallback 'default' (resolvable, but no registry row to edit).
    throw new ProjectRowMissing(ref)
  }
  const conn = patch.connection
  if (conn && row.stack_kind === 'shared-db') {
    const hostRef = (row.stack_meta as Record<string, unknown> | null)?.host_ref
    throw new SharedDbLocked(
      `Connection fields of a shared-db project are managed by its host stack${typeof hostRef === 'string' ? ` "${hostRef}"` : ''}`
    )
  }

  // Probe-before-save (spec D3): presence-based — any effective connection
  // field requires the merged candidate DSN to answer `select 1` first.
  if (conn) {
    const probe = await probeConnection({
      dbHost: conn.dbHost ?? row.db_host,
      dbPort: conn.dbPort ?? row.db_port,
      dbName: conn.dbName ?? row.db_name,
      dbUser: conn.dbUser ?? row.db_user,
      dbPass: conn.dbPass ?? decryptSecret(row.db_pass_enc),
    })
    if (!probe.ok) throw new ProbeFailed(probe.error)
  }

  // SET clause: column names only ever come from the literals below —
  // values are fully parameterized (M5.0 injection-barrier class).
  const sets: string[] = []
  const parameters: unknown[] = [ref]
  const set = (column: string, v: unknown) => {
    parameters.push(v)
    sets.push(`${column} = $${parameters.length}`)
  }
  if (patch.name !== undefined) set('name', patch.name)
  if (conn) {
    if (conn.dbHost !== undefined) set('db_host', conn.dbHost)
    if (conn.dbPort !== undefined) set('db_port', conn.dbPort)
    if (conn.dbName !== undefined) set('db_name', conn.dbName)
    if (conn.dbUser !== undefined) set('db_user', conn.dbUser)
    if (conn.dbUserReadonly !== undefined) set('db_user_readonly', conn.dbUserReadonly)
    if (conn.kongUrl !== undefined) set('kong_url', conn.kongUrl)
    if (conn.restUrl !== undefined) set('rest_url', conn.restUrl)
    if (conn.dbPass !== undefined) set('db_pass_enc', encryptSecret(conn.dbPass))
    if (conn.anonKey !== undefined) set('anon_key_enc', encryptSecret(conn.anonKey))
    if (conn.serviceKey !== undefined) set('service_key_enc', encryptSecret(conn.serviceKey))
    if (conn.jwtSecret !== undefined) set('jwt_secret_enc', encryptSecret(conn.jwtSecret))
    if (conn.publishableKey !== undefined) {
      set(
        'publishable_key_enc',
        conn.publishableKey === null ? null : encryptSecret(conn.publishableKey)
      )
    }
    if (conn.secretKey !== undefined) {
      set('secret_key_enc', conn.secretKey === null ? null : encryptSecret(conn.secretKey))
    }
  }
  if (patch.logflareUrl !== undefined) set('logflare_url', patch.logflareUrl)
  if (patch.logflareToken !== undefined) {
    set(
      'logflare_token_enc',
      patch.logflareToken === null ? null : encryptSecret(patch.logflareToken)
    )
  }
  if (sets.length === 0) throw new Error('empty project patch') // parse guarantees ≥1 — defense only

  const update = await executePlatformQuery({
    query: `update platform.projects set ${sets.join(', ')}, updated_at = now() where ref = $1`,
    parameters,
  })
  if (update.error) throw update.error

  // Propagation (spec D7): FULL cloned-set re-sync from the host row's
  // post-update values — children become exact clones again (heals any
  // historical drift), maximally idempotent. Second sequential statement,
  // no transaction wrapper (M5.0 delete+GC precedent on this channel); a
  // crash between the two leaves stale children and re-sending the same
  // PATCH heals them (README records the window).
  let propagatedChildren: string[] = []
  const touchedCloned =
    conn !== undefined && PROPAGATED_CONNECTION_KEYS.some((k) => conn[k] !== undefined)
  if (row.stack_kind === 'external' && touchedCloned) {
    const prop = await executePlatformQuery<{ ref: string }>({
      query: `update platform.projects c set
          db_host = h.db_host, db_port = h.db_port,
          db_user = h.db_user, db_user_readonly = h.db_user_readonly,
          kong_url = h.kong_url, rest_url = h.rest_url,
          db_pass_enc = h.db_pass_enc, service_key_enc = h.service_key_enc,
          anon_key_enc = h.anon_key_enc, jwt_secret_enc = h.jwt_secret_enc,
          publishable_key_enc = h.publishable_key_enc, secret_key_enc = h.secret_key_enc,
          updated_at = now()
        from platform.projects h
        where h.ref = $1
          and c.stack_kind = 'shared-db'
          and c.stack_meta->>'host_ref' = $1
        returning c.ref`,
      parameters: [ref],
    })
    if (prop.error) {
      // Pre-M5.0 platform-db (no 07-stack-metadata.sql): stack columns are
      // absent, so there can be no shared-db children to re-sync — degrade
      // to zero children like the GET side (buildSelfPlatformBlock) instead
      // of failing the request after the host row is already written. PG
      // renders the qualified column as `c.stack_kind` (unquoted), so match
      // loosely rather than via MISSING_STACK_COLUMN.
      if (/stack_kind.* does not exist/.test(prop.error.message)) {
        return { propagatedChildren: [] }
      }
      throw prop.error
    }
    propagatedChildren = (prop.data ?? []).map((r) => r.ref)
  }
  return { propagatedChildren }
}
