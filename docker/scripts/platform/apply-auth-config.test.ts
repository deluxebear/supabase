// docker/scripts/platform/apply-auth-config.test.ts
import { describe, expect, it } from 'vitest'

import {
  maskSecretValues,
  parseArgs,
  renderGotrueEnv,
  toComposeOverrideYaml,
} from './apply-auth-config'

describe('parseArgs', () => {
  it('reads the ref, --target, and --dry-run', () => {
    expect(parseArgs(['default'])).toEqual({ ref: 'default', target: undefined, dryRun: false })
    expect(parseArgs(['proj-b', '--target', 'proj-b-auth', '--dry-run'])).toEqual({
      ref: 'proj-b',
      target: 'proj-b-auth',
      dryRun: true,
    })
  })
})

describe('renderGotrueEnv', () => {
  it('maps fields to GOTRUE_<field>, formats scalars, skips null and read-only fields', () => {
    const env = renderGotrueEnv({
      DISABLE_SIGNUP: true,
      JWT_EXP: 3600,
      SITE_URL: 'http://localhost:8082',
      URI_ALLOW_LIST: ['http://a', 'http://b'],
      SMTP_PASS: 'plaintext-decrypted',
      MAILER_AUTOCONFIRM: null,
      CUSTOM_OAUTH_MAX_PROVIDERS: 50, // read-only → never rendered
    })
    expect(env).toEqual({
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_SITE_URL: 'http://localhost:8082',
      GOTRUE_URI_ALLOW_LIST: 'http://a,http://b',
      GOTRUE_SMTP_PASS: 'plaintext-decrypted',
    })
  })
})

describe('maskSecretValues', () => {
  it('masks listed keys to ****** and leaves others untouched', () => {
    const env = {
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_SITE_URL: 'http://localhost:8082',
      GOTRUE_SMTP_PASS: 'plaintext-decrypted',
      GOTRUE_SECURITY_CAPTCHA_SECRET: 'super-secret-value',
    }
    const masked = maskSecretValues(
      env,
      new Set(['GOTRUE_SMTP_PASS', 'GOTRUE_SECURITY_CAPTCHA_SECRET'])
    )
    expect(masked).toEqual({
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_SITE_URL: 'http://localhost:8082',
      GOTRUE_SMTP_PASS: '******',
      GOTRUE_SECURITY_CAPTCHA_SECRET: '******',
    })
  })
})

describe('toComposeOverrideYaml', () => {
  it('emits a services.<svc>.environment block with quoted values', () => {
    const yaml = toComposeOverrideYaml('supabase-auth', {
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_SITE_URL: 'http://localhost:8082',
    })
    expect(yaml).toContain('services:')
    expect(yaml).toContain('  supabase-auth:')
    expect(yaml).toContain('    environment:')
    expect(yaml).toContain('      GOTRUE_DISABLE_SIGNUP: "true"')
    expect(yaml).toContain('      GOTRUE_SITE_URL: "http://localhost:8082"')
  })
})
