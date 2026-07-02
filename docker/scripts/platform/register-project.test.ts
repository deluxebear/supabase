import { describe, expect, it } from 'vitest'

import { buildRowParams, buildUpsertSql, parseArgs, resolveInputFromEnv } from './register-project'

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
  it('maps docker env to a register input', () => {
    const input = resolveInputFromEnv(
      {
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'postgres',
        POSTGRES_PASSWORD: 'pw',
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_PUBLIC_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_KEY: 'svc',
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
      kongUrl: 'http://kong:8000',
    })
  })
})
