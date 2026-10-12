import { z } from 'zod'

import { DEFAULTS } from './auth-config'
import { resolveProjectConnection } from './resolve-connection'

// [self-platform] GoTrue's public `/settings` reports the values Auth runs with
// for its main switches. Studio shows them for fields the operator has not
// stored, so a save does not silently replace the running value with a default.
const settingsSchema = z.object({
  external: z.record(z.string(), z.boolean()).optional(),
  disable_signup: z.boolean().optional(),
  mailer_autoconfirm: z.boolean().optional(),
  phone_autoconfirm: z.boolean().optional(),
  sms_provider: z.string().optional(),
  saml_enabled: z.boolean().optional(),
  passkeys_enabled: z.boolean().optional(),
})

const KNOWN_FIELDS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS))

export function mapLiveAuthSettings(raw: unknown): Record<string, unknown> {
  const parsed = settingsSchema.safeParse(raw)
  if (!parsed.success) return {}
  const settings = parsed.data
  const live: Record<string, unknown> = {
    DISABLE_SIGNUP: settings.disable_signup,
    MAILER_AUTOCONFIRM: settings.mailer_autoconfirm,
    SMS_AUTOCONFIRM: settings.phone_autoconfirm,
    SAML_ENABLED: settings.saml_enabled,
    PASSKEY_ENABLED: settings.passkeys_enabled,
    // An empty provider means none is configured; keep Studio's default then.
    SMS_PROVIDER: settings.sms_provider || undefined,
  }
  for (const [provider, isEnabled] of Object.entries(settings.external ?? {})) {
    live[`EXTERNAL_${provider.toUpperCase()}_ENABLED`] = isEnabled
  }
  return Object.fromEntries(
    Object.entries(live).filter(([field, value]) => value !== undefined && KNOWN_FIELDS.has(field))
  )
}

/** Live values, or an empty object when Auth cannot be reached. */
export async function readLiveAuthSettings(
  projectRef: string,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  try {
    const conn = await resolveProjectConnection(projectRef)
    if (!conn.supabaseUrl || !conn.anonKey) return {}
    const response = await fetchImpl(`${conn.supabaseUrl.replace(/\/$/, '')}/auth/v1/settings`, {
      headers: { apikey: conn.anonKey },
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return {}
    return mapLiveAuthSettings(await response.json())
  } catch {
    return {}
  }
}
