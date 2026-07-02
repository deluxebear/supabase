#!/usr/bin/env tsx
// [self-platform] Admin CLI to register an existing Supabase stack into
// platform.projects. Secrets are AES-encrypted with PLATFORM_ENCRYPTION_KEY
// (same scheme as apps/studio/lib/api/self-platform/secrets.ts).
import { execFileSync } from 'node:child_process'
import crypto from 'crypto-js'

export interface RegisterInput {
  ref: string
  org: string
  name: string
  status?: string
  cloudProvider?: string
  region?: string
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  dbUserReadonly?: string
  kongUrl: string
  restUrl: string
  dbPass: string
  serviceKey: string
  anonKey: string
  jwtSecret: string
  publishableKey?: string | null
  secretKey?: string | null
  logflareUrl?: string | null
  logflareToken?: string | null
}

export function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv
  const flags: Record<string, string> = {}
  let fromCurrentEnv = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--from-current-env') {
      fromCurrentEnv = true
      continue
    }
    if (a.startsWith('--')) {
      flags[a.slice(2)] = rest[i + 1]
      i++
    }
  }
  return { cmd: (cmd as 'register' | 'deregister' | 'list') ?? 'list', flags, fromCurrentEnv }
}

export function encryptSecret(
  plaintext: string,
  key = process.env.PLATFORM_ENCRYPTION_KEY || ''
): string {
  if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY is not set')
  return crypto.AES.encrypt(plaintext, key).toString()
}

export function buildUpsertSql(): { query: string } {
  return {
    query: `insert into platform.projects
      (ref, organization_id, name, status, cloud_provider, region,
       db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
       db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc, publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc)
      values ($1,(select id from platform.organizations where slug=$2),$3,$4,$5,$6,
              $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      on conflict (ref) do update set
        name=excluded.name, status=excluded.status, cloud_provider=excluded.cloud_provider,
        region=excluded.region, db_host=excluded.db_host, db_port=excluded.db_port,
        db_name=excluded.db_name, db_user=excluded.db_user, db_user_readonly=excluded.db_user_readonly,
        kong_url=excluded.kong_url, rest_url=excluded.rest_url,
        db_pass_enc=excluded.db_pass_enc, service_key_enc=excluded.service_key_enc,
        anon_key_enc=excluded.anon_key_enc, jwt_secret_enc=excluded.jwt_secret_enc,
        publishable_key_enc=excluded.publishable_key_enc, secret_key_enc=excluded.secret_key_enc,
        logflare_url=excluded.logflare_url, logflare_token_enc=excluded.logflare_token_enc,
        updated_at=now()`,
  }
}

export function buildRowParams(input: RegisterInput, encrypt: (s: string) => string): unknown[] {
  return [
    input.ref,
    input.org,
    input.name,
    input.status ?? 'ACTIVE_HEALTHY',
    input.cloudProvider ?? 'AWS',
    input.region ?? 'local',
    input.dbHost,
    input.dbPort,
    input.dbName,
    input.dbUser,
    input.dbUserReadonly ?? 'supabase_read_only_user',
    input.kongUrl,
    input.restUrl,
    encrypt(input.dbPass),
    encrypt(input.serviceKey),
    encrypt(input.anonKey),
    encrypt(input.jwtSecret),
    input.publishableKey ? encrypt(input.publishableKey) : null,
    input.secretKey ? encrypt(input.secretKey) : null,
    input.logflareUrl ?? null,
    input.logflareToken ? encrypt(input.logflareToken) : null,
  ]
}

// [self-platform] Maps the *actual* docker/.env variable names (see
// docker/docker-compose.yml + docker/.env.example) to a RegisterInput.
// SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_KEY are NOT present in
// docker/.env (SUPABASE_URL is only ever hardcoded per-service inside
// docker-compose.yml); the real stack uses API_EXTERNAL_URL/
// SUPABASE_PUBLIC_URL and ANON_KEY/SERVICE_ROLE_KEY. Fallbacks to the old
// names are kept for forwards-compat with hand-rolled .env files that use
// the upstream supabase/supabase naming.
export function resolveInputFromEnv(
  env: NodeJS.ProcessEnv,
  base: { ref: string; org: string; name: string }
): RegisterInput {
  // kongUrl is the browser-facing gateway URL (used by Studio's frontend to
  // reach the project), NOT the docker-network-internal kong:8000 address.
  const kong = env.SUPABASE_URL || env.API_EXTERNAL_URL || env.SUPABASE_PUBLIC_URL || ''
  return {
    ...base,
    // dbHost MUST be the docker-network hostname (e.g. "db") reachable from
    // the pg-meta container — never localhost/127.0.0.1, which only resolves
    // to the host running this CLI, not the container network.
    dbHost: env.POSTGRES_HOST || 'db',
    dbPort: parseInt(env.POSTGRES_PORT || '5432', 10),
    dbName: env.POSTGRES_DB || 'postgres',
    dbUser: env.POSTGRES_USER_READ_WRITE || 'supabase_admin',
    dbUserReadonly: env.POSTGRES_USER_READ_ONLY || 'supabase_read_only_user',
    kongUrl: kong,
    restUrl: (env.SUPABASE_PUBLIC_URL || kong).replace(/\/$/, '') + '/rest/v1/',
    dbPass: env.POSTGRES_PASSWORD || '',
    serviceKey: env.SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '',
    anonKey: env.ANON_KEY || env.SUPABASE_ANON_KEY || '',
    jwtSecret: env.JWT_SECRET || env.AUTH_JWT_SECRET || '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || null,
    secretKey: env.SUPABASE_SECRET_KEY || null,
    logflareUrl: env.LOGFLARE_URL || null,
    logflareToken: env.LOGFLARE_PRIVATE_ACCESS_TOKEN || null,
  }
}

// [self-platform] Guards both register branches (explicit --flags and
// --from-current-env) against silently writing empty-string-encrypted
// secrets. resolveInputFromEnv defaults missing env vars to '', so without
// this check a misconfigured shell (stack env not sourced) would still
// exit 0 having registered a project nothing can connect to.
const REQUIRED_INPUT_FIELDS: Array<[keyof RegisterInput, string]> = [
  ['ref', 'ref'],
  ['org', 'org'],
  ['name', 'name'],
  ['dbHost', 'dbHost'],
  ['kongUrl', 'kongUrl'],
  ['dbPass', 'dbPass'],
  ['serviceKey', 'serviceKey'],
  ['anonKey', 'anonKey'],
  ['jwtSecret', 'jwtSecret'],
]

export function assertRequiredInput(input: RegisterInput): void {
  const missing = REQUIRED_INPUT_FIELDS.filter(([key]) => {
    const value = input[key]
    return value === undefined || value === null || String(value).trim() === ''
  }).map(([, label]) => label)
  if (missing.length) {
    throw new Error(`missing required field(s): ${missing.join(', ')}`)
  }
}

// --- main (not unit-tested; exercised by the real-PG step) ---

// Renders a single bound value as a SQL literal for inlining into an EXECUTE
// call. Strings are single-quote-escaped (doubling '); numbers are inlined
// bare; null/undefined become SQL NULL. This is the "stdin here-doc" fallback
// noted in the task brief: the brief's original PREPARE/EXECUTE sketch reused
// `$n` placeholders inside the EXECUTE(...) argument list, which is invalid
// SQL (EXECUTE takes literal values, not further placeholders) and would fail
// against a real server. `pg` (node-postgres) is not a dependency anywhere in
// this monorepo (checked apps/studio + root package.json), so rather than add
// a new dependency for a single admin CLI, values are escaped and inlined as
// SQL literals into the EXECUTE argument list, which is still sent over
// stdin (never argv/shell history) to `docker exec -i psql`.
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

function psql(sql: string, params: unknown[] = []): string {
  const container = process.env.PLATFORM_DB_CONTAINER || 'supabase-platform-db'
  const prepared = params.length
    ? `PREPARE stmt AS ${sql}; EXECUTE stmt(${params.map((p) => sqlLiteral(p)).join(',')}); DEALLOCATE stmt;`
    : sql
  return execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'platform', '-v', 'ON_ERROR_STOP=1'],
    { input: prepared + '\n', encoding: 'utf8' }
  )
}

function required(flags: Record<string, string>, keys: string[]) {
  const missing = keys.filter((k) => !flags[k])
  if (missing.length)
    throw new Error(`missing required flags: ${missing.map((k) => '--' + k).join(', ')}`)
}

export function main(argv = process.argv.slice(2)) {
  const { cmd, flags, fromCurrentEnv } = parseArgs(argv)
  if (cmd === 'list') {
    process.stdout.write(
      psql('select ref, organization_id, name, status, db_host from platform.projects order by id;')
    )
    return
  }
  if (cmd === 'deregister') {
    required(flags, ['ref'])
    psql(`delete from platform.projects where ref = '${flags.ref.replace(/'/g, "''")}';`)
    process.stdout.write(`deregistered ${flags.ref}\n`)
    return
  }
  // register
  const input = fromCurrentEnv
    ? resolveInputFromEnv(process.env, {
        ref: flags.ref || 'default',
        org: flags.org || 'default',
        name: flags.name || process.env.DEFAULT_PROJECT_NAME || 'Default Project',
      })
    : (() => {
        required(flags, [
          'ref',
          'org',
          'name',
          'db-host',
          'kong-url',
          'db-pass',
          'service-key',
          'anon-key',
          'jwt-secret',
        ])
        return {
          ref: flags.ref,
          org: flags.org,
          name: flags.name,
          dbHost: flags['db-host'],
          dbPort: parseInt(flags['db-port'] || '5432', 10),
          dbName: flags['db-name'] || 'postgres',
          dbUser: flags['db-user'] || 'supabase_admin',
          dbUserReadonly: flags['db-user-readonly'] || 'supabase_read_only_user',
          kongUrl: flags['kong-url'],
          restUrl: flags['rest-url'] || flags['kong-url'].replace(/\/$/, '') + '/rest/v1/',
          dbPass: flags['db-pass'],
          serviceKey: flags['service-key'],
          anonKey: flags['anon-key'],
          jwtSecret: flags['jwt-secret'],
          publishableKey: flags['publishable-key'] || null,
          secretKey: flags['secret-key'] || null,
          logflareUrl: flags['logflare-url'] || null,
          logflareToken: flags['logflare-token'] || null,
        } as RegisterInput
      })()
  // Belt-and-suspenders: required(flags, [...]) above only checks the
  // explicit-flags branch. This also catches a misconfigured
  // --from-current-env (resolveInputFromEnv defaults missing vars to '')
  // AND anything the explicit branch let through (e.g. a flag set to '').
  assertRequiredInput(input)
  const { query } = buildUpsertSql()
  psql(
    query,
    buildRowParams(input, (s) => encryptSecret(s))
  )
  process.stdout.write(`registered ${input.ref} (org ${input.org})\n`)
}

// tsx entry
if (import.meta.url === `file://${process.argv[1]}`) main()
