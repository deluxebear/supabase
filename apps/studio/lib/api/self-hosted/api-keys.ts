/**
 * Both CLI and self-hosted inject the same env vars.
 */
import { assertSelfHosted } from './util'

export type NonPlatformApiKey = {
  name: string
  api_key: string
  id: string
  type: 'legacy' | 'publishable' | 'secret'
  hash: string
  prefix: string
  description: string
}

/**
 * Length of the identifying prefix shown for a secret key before it is
 * revealed. Mirrors the platform management API and the `ApiKeyPill` UI.
 */
const SECRET_KEY_VISIBLE_PREFIX_LENGTH = 15

export function parseRevealQuery(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'true'
}

// [self-platform] Optional `resolved` param: with it, uses the
// per-project keys from a registry-resolved connection (self-platform
// multi-project). Without it, the historical global-env path — byte
// identical to M1 — keeps plain self-hosted zero-break.
export function getNonPlatformApiKeys(resolved?: {
  anonKey: string
  serviceKey: string
  publishableKey: string | null
  secretKey: string | null
}): NonPlatformApiKey[] {
  assertSelfHosted()

  const anon = resolved ? resolved.anonKey : (process.env.SUPABASE_ANON_KEY ?? '')
  const service = resolved ? resolved.serviceKey : (process.env.SUPABASE_SERVICE_KEY ?? '')

  const keys: NonPlatformApiKey[] = [
    {
      name: 'anon',
      api_key: anon,
      id: 'anon',
      type: 'legacy',
      hash: '',
      prefix: '',
      description: 'Legacy anon API key',
    },
    {
      name: 'service_role',
      api_key: service,
      id: 'service_role',
      type: 'legacy',
      hash: '',
      prefix: '',
      description: 'Legacy service_role API key',
    },
  ]

  const publishableKey = resolved ? resolved.publishableKey : process.env.SUPABASE_PUBLISHABLE_KEY
  if (publishableKey) {
    keys.push({
      name: 'publishable',
      api_key: publishableKey,
      id: 'publishable',
      type: 'publishable',
      hash: '',
      prefix: '',
      description: 'Publishable API key (anon role)',
    })
  }

  const secretKey = resolved ? resolved.secretKey : process.env.SUPABASE_SECRET_KEY
  if (secretKey) {
    keys.push({
      name: 'secret',
      api_key: secretKey,
      id: 'secret',
      type: 'secret',
      hash: '',
      // Only expose the prefix when the key is genuinely longer than the prefix.
      prefix:
        secretKey.length > SECRET_KEY_VISIBLE_PREFIX_LENGTH
          ? secretKey.slice(0, SECRET_KEY_VISIBLE_PREFIX_LENGTH)
          : '',
      description: 'Secret API key (service_role)',
    })
  }

  return keys
}

export function applyRevealToApiKey(key: NonPlatformApiKey, reveal: boolean): NonPlatformApiKey {
  if (key.type !== 'secret' || reveal) return key

  return { ...key, api_key: key.prefix }
}

// [self-platform] Optional `resolved` param mirrors getNonPlatformApiKeys:
// with it, looks up the per-project key from a registry-resolved connection
// (self-platform multi-project). Without it, the historical global-env path —
// byte identical to M1 — keeps plain self-hosted zero-break.
export function getNonPlatformApiKeyById(
  id: string,
  reveal: boolean,
  resolved?: Parameters<typeof getNonPlatformApiKeys>[0]
): NonPlatformApiKey | undefined {
  const key = getNonPlatformApiKeys(resolved).find((entry) => entry.id === id)
  if (!key) return undefined

  return applyRevealToApiKey(key, reveal)
}
