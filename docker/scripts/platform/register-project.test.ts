import { describe, expect, it } from 'vitest'

import {
  assertRequiredInput,
  buildRowParams,
  buildUpsertSql,
  parseArgs,
  resolveInputFromEnv,
} from './register-project'

describe('parseArgs', () => {
  it('parses register with flags', () => {
    const r = parseArgs(['register', '--ref', 'proj-b', '--org', 'default', '--name', 'B'])
    expect(r.cmd).toBe('register')
    expect(r.flags.ref).toBe('proj-b')
    expect(r.flags.org).toBe('default')
    expect(r.fromCurrentEnv).toBe(false)
  })
  it('parses --from-current-env', () => {
    const r = parseArgs(['register', '--from-current-env'])
    expect(r.fromCurrentEnv).toBe(true)
  })
  it('parses deregister and list', () => {
    expect(parseArgs(['deregister', '--ref', 'x']).cmd).toBe('deregister')
    expect(parseArgs(['list']).cmd).toBe('list')
  })
})

describe('buildUpsertSql', () => {
  it('is a parameterized upsert on ref conflict', () => {
    const { query } = buildUpsertSql()
    expect(query).toContain('insert into platform.projects')
    expect(query).toContain('on conflict (ref) do update')
    expect(query).toContain('$1')
    expect(query).not.toMatch(/service_key_enc\s*=\s*'/) // no literal secret
  })
})

describe('buildRowParams', () => {
  it('encrypts secret fields via the injected encryptor and orders params', () => {
    const input = {
      ref: 'proj-b',
      org: 'default',
      name: 'B',
      status: 'ACTIVE_HEALTHY',
      cloudProvider: 'AWS',
      region: 'local',
      dbHost: 'db-b',
      dbPort: 5432,
      dbName: 'postgres',
      dbUser: 'supabase_admin',
      dbUserReadonly: 'ro',
      kongUrl: 'http://kong-b:8000',
      restUrl: 'http://kong-b:8000/rest/v1/',
      dbPass: 'PW',
      serviceKey: 'SVC',
      anonKey: 'ANON',
      jwtSecret: 'JWT',
      publishableKey: null,
      secretKey: null,
    }
    const params = buildRowParams(input, (s: string) => `E(${s})`)
    expect(params).toContain('proj-b')
    expect(params).toContain('E(PW)')
    expect(params).toContain('E(SVC)')
    expect(params).toContain('E(JWT)')
    expect(params).not.toContain('PW') // raw secret never in params
  })
})

describe('resolveInputFromEnv', () => {
  it('maps the real docker/.env variable names to a register input', () => {
    // These are the actual names present in docker/.env (verified via
    // `grep -E '^(POSTGRES_|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|SUPABASE_|API_EXTERNAL_URL|KONG_)' docker/.env`),
    // NOT the upstream supabase/supabase names (SUPABASE_ANON_KEY,
    // SUPABASE_SERVICE_KEY) this used to read.
    const input = resolveInputFromEnv(
      {
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'postgres',
        POSTGRES_PASSWORD: 'pw',
        API_EXTERNAL_URL: 'http://localhost:8100',
        SUPABASE_PUBLIC_URL: 'http://localhost:8100',
        ANON_KEY: 'anon',
        SERVICE_ROLE_KEY: 'svc',
        JWT_SECRET: 'jwt',
      } as any,
      { ref: 'default', org: 'default', name: 'Default Project' }
    )
    expect(input).toMatchObject({
      ref: 'default',
      org: 'default',
      dbHost: 'db',
      dbPass: 'pw',
      serviceKey: 'svc',
      anonKey: 'anon',
      jwtSecret: 'jwt',
      kongUrl: 'http://localhost:8100',
      restUrl: 'http://localhost:8100/rest/v1/',
    })
  })

  it('falls back to the upstream supabase/supabase env names when present', () => {
    const input = resolveInputFromEnv(
      {
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon-old',
        SUPABASE_SERVICE_KEY: 'svc-old',
      } as any,
      { ref: 'default', org: 'default', name: 'Default Project' }
    )
    expect(input).toMatchObject({
      kongUrl: 'http://kong:8000',
      anonKey: 'anon-old',
      serviceKey: 'svc-old',
    })
  })
})

describe('assertRequiredInput', () => {
  const validInput = {
    ref: 'default',
    org: 'default',
    name: 'Default Project',
    dbHost: 'db',
    dbPort: 5432,
    dbName: 'postgres',
    dbUser: 'supabase_admin',
    kongUrl: 'http://localhost:8100',
    restUrl: 'http://localhost:8100/rest/v1/',
    dbPass: 'pw',
    serviceKey: 'svc',
    anonKey: 'anon',
    jwtSecret: 'jwt',
  }

  it('does not throw when every critical field is populated', () => {
    expect(() => assertRequiredInput(validInput as any)).not.toThrow()
  })

  it('throws mentioning the missing field when resolveInputFromEnv is given an env missing SERVICE_ROLE_KEY', () => {
    const input = resolveInputFromEnv(
      {
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'postgres',
        POSTGRES_PASSWORD: 'pw',
        API_EXTERNAL_URL: 'http://localhost:8100',
        SUPABASE_PUBLIC_URL: 'http://localhost:8100',
        ANON_KEY: 'anon',
        // SERVICE_ROLE_KEY intentionally omitted
        JWT_SECRET: 'jwt',
      } as any,
      { ref: 'default', org: 'default', name: 'Default Project' }
    )
    expect(() => assertRequiredInput(input)).toThrowError(/serviceKey/)
  })

  it('throws mentioning every missing field for a fully-empty env', () => {
    // dbHost always defaults to 'db' inside resolveInputFromEnv (it's the
    // docker-network hostname, safe to default), so it's excluded here —
    // every other critical field defaults to '' and must be reported.
    const input = resolveInputFromEnv({} as any, { ref: '', org: '', name: '' })
    expect(() => assertRequiredInput(input)).toThrowError(
      /ref.*org.*name.*kongUrl.*dbPass.*serviceKey.*anonKey.*jwtSecret/
    )
  })
})
