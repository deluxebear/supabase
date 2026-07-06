import { describe, expect, it } from 'vitest'

import {
  assertRequiredInput,
  assertValidStackKind,
  buildRowParams,
  buildUpsertSql,
  parseArgs,
  resolveInputFromEnv,
} from './register-project'

function baseInput() {
  return {
    ref: 'r',
    org: 'o',
    name: 'n',
    dbHost: 'db',
    dbPort: 5432,
    dbName: 'postgres',
    dbUser: 'u',
    kongUrl: 'http://k',
    restUrl: 'http://k/rest/v1/',
    dbPass: 'p',
    serviceKey: 's',
    anonKey: 'a',
    jwtSecret: 'j',
  }
}

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

describe('analytics fields (M2.1)', () => {
  it('buildUpsertSql includes logflare columns as $20/$21', () => {
    const { query } = buildUpsertSql()
    expect(query).toContain('logflare_url')
    expect(query).toContain('logflare_token_enc')
    expect(query).toContain('$21')
    expect(query).toContain('logflare_url=excluded.logflare_url')
  })

  it('buildRowParams encrypts token and passes url through; null when absent', () => {
    const base = {
      ref: 'r',
      org: 'o',
      name: 'n',
      dbHost: 'db',
      dbPort: 5432,
      dbName: 'postgres',
      dbUser: 'u',
      kongUrl: 'http://k',
      restUrl: 'http://k/rest/v1/',
      dbPass: 'p',
      serviceKey: 's',
      anonKey: 'a',
      jwtSecret: 'j',
    }
    const enc = (s: string) => `enc(${s})`
    const withAnalytics = buildRowParams(
      { ...base, logflareUrl: 'http://lf', logflareToken: 'tok' } as any,
      enc
    )
    // M6.3: length 22->24 and stack_kind index 21->23 — metrics_url/token
    // (M6.3) are inserted between logflare_token_enc and stack_kind.
    expect(withAnalytics).toHaveLength(24)
    expect(withAnalytics[19]).toBe('http://lf')
    expect(withAnalytics[20]).toBe('enc(tok)')
    expect(withAnalytics[23]).toBe('external')
    const without = buildRowParams(base as any, enc)
    expect(without[19]).toBeNull()
    expect(without[20]).toBeNull()
    expect(without[23]).toBe('external')
  })

  it('resolveInputFromEnv picks up LOGFLARE_URL and LOGFLARE_PRIVATE_ACCESS_TOKEN', () => {
    const input = resolveInputFromEnv(
      {
        POSTGRES_PASSWORD: 'p',
        SERVICE_ROLE_KEY: 's',
        ANON_KEY: 'a',
        JWT_SECRET: 'j',
        API_EXTERNAL_URL: 'http://k',
        LOGFLARE_URL: 'http://lf',
        LOGFLARE_PRIVATE_ACCESS_TOKEN: 'tok',
      } as any,
      { ref: 'default', org: 'default', name: 'D' }
    )
    expect(input.logflareUrl).toBe('http://lf')
    expect(input.logflareToken).toBe('tok')
  })

  it('analytics fields are not required', () => {
    const input = resolveInputFromEnv(
      {
        POSTGRES_PASSWORD: 'p',
        SERVICE_ROLE_KEY: 's',
        ANON_KEY: 'a',
        JWT_SECRET: 'j',
        API_EXTERNAL_URL: 'http://k',
      } as any,
      { ref: 'default', org: 'default', name: 'D' }
    )
    expect(input.logflareUrl).toBeNull()
    expect(() => assertRequiredInput(input)).not.toThrow()
  })
})

describe('metrics fields (M6.3)', () => {
  const ENV_BASE = {
    POSTGRES_PASSWORD: 'p',
    SERVICE_ROLE_KEY: 's',
    ANON_KEY: 'a',
    JWT_SECRET: 'j',
    API_EXTERNAL_URL: 'http://k',
  }

  it('passes metrics url through and encrypts metrics token (M6.3)', () => {
    const BASE_INPUT = baseInput()
    const params = buildRowParams(
      { ...BASE_INPUT, metricsUrl: 'http://h:9598/metrics', metricsToken: 'mtok' },
      (s) => `enc(${s})`
    )
    expect(params[21]).toBe('http://h:9598/metrics') // metrics_url ($22)
    expect(params[22]).toBe('enc(mtok)') // metrics_token_enc ($23)
    expect(params[23]).toBe((BASE_INPUT as any).stackKind ?? 'external') // stack_kind shifted to $24
  })

  it('metrics fields default to null and are optional', () => {
    const params = buildRowParams(baseInput(), (s) => s)
    expect(params[21]).toBeNull()
    expect(params[22]).toBeNull()
  })

  it('upsert SQL carries the metrics columns', () => {
    const { query } = buildUpsertSql()
    expect(query).toContain('metrics_url')
    expect(query).toContain('metrics_token_enc=excluded.metrics_token_enc')
  })

  it('resolveInputFromEnv reads METRICS_URL and leaves token null', () => {
    const input = resolveInputFromEnv(
      { ...ENV_BASE, METRICS_URL: 'http://h:9598/metrics' } as any,
      { ref: 'r', org: 'o', name: 'n' }
    )
    expect(input.metricsUrl).toBe('http://h:9598/metrics')
    expect(input.metricsToken).toBeNull()
  })
})

describe('stack_kind (M5.0)', () => {
  it('upsert SQL carries stack_kind as $22 and updates it on conflict', () => {
    const { query } = buildUpsertSql()
    expect(query).toContain('stack_kind')
    expect(query).toContain('$22')
    expect(query).toContain('stack_kind=excluded.stack_kind')
  })

  it('buildRowParams appends stackKind, defaulting to external', () => {
    // M6.3: length 22->24 and index 21->23 — metrics_url/token inserted
    // between logflare_token_enc and stack_kind (see 'metrics fields (M6.3)').
    const params = buildRowParams(baseInput(), (s) => `enc(${s})`)
    expect(params).toHaveLength(24)
    expect(params[23]).toBe('external')
    const explicit = buildRowParams({ ...baseInput(), stackKind: 'shared-db' }, (s) => `enc(${s})`)
    expect(explicit[23]).toBe('shared-db')
  })

  it('parseArgs picks up --stack-kind', () => {
    const { flags } = parseArgs(['register', '--ref', 'x', '--stack-kind', 'k8s'])
    expect(flags['stack-kind']).toBe('k8s')
  })

  it('assertValidStackKind accepts the three kinds and rejects garbage', () => {
    for (const k of ['external', 'shared-db', 'k8s']) {
      expect(() => assertValidStackKind(k)).not.toThrow()
    }
    expect(() => assertValidStackKind('compose')).toThrow(/invalid --stack-kind/)
  })
})
