import { describe, expect, it } from 'vitest'

import { toComposeOverrideYaml } from './auth-runtime'
import { planFunctionSecretsEnv } from './function-secrets-apply'

describe('planFunctionSecretsEnv', () => {
  it('delivers custom secrets and holds back reserved names', () => {
    expect(
      planFunctionSecretsEnv({
        STRIPE_KEY: 'sk_test',
        stripe_webhook: 'whsec',
        SUPABASE_URL: 'http://evil',
        VERIFY_JWT: 'false',
      })
    ).toEqual({
      env: { STRIPE_KEY: 'sk_test', stripe_webhook: 'whsec' },
      reservedNames: ['SUPABASE_URL', 'VERIFY_JWT'],
    })
  })

  it('renders lowercase names and escapes Compose interpolation', () => {
    const { env } = planFunctionSecretsEnv({ stripe_webhook: 'a$b"c' })
    expect(toComposeOverrideYaml('functions', env, '# header')).toBe(
      '# header\nservices:\n  functions:\n    environment:\n      stripe_webhook: "a$$b\\"c"\n'
    )
  })
})
