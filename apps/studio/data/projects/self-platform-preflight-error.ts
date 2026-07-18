/**
 * Formats Fleet attachment-preflight failures for Studio UI.
 *
 * The PATCH /platform/projects/{ref} route returns:
 *   { code: 'preflight_failed', message: 'Attachment preflight failed', preflight: { checks: [...] } }
 * openapi-fetch surfaces that object as `error`. Without formatting, operators only see the
 * generic message and cannot tell which check failed (e.g. SSL vs Auth vs REST).
 *
 * English source strings are i18n keys (same convention as the rest of Studio).
 */

import { t as $t } from '@/lib/i18n'

export type PreflightCheckLike = {
  name: string
  status: string
  required?: boolean
  message?: string
  remediation?: string
}

export type PreflightReportLike = {
  outcome?: string
  checks?: PreflightCheckLike[]
}

/** Human-readable English labels for preflight check ids (also used as zh-CN keys). */
export const PREFLIGHT_CHECK_LABELS: Record<string, string> = {
  'key-mode': 'Credential key mode',
  'database-connectivity': 'Database connectivity',
  'postgres-identity': 'PostgreSQL identity',
  'metadata-permissions': 'Database metadata permissions',
  gateway: 'API gateway',
  auth: 'Auth service',
  rest: 'REST / PostgREST',
  storage: 'Storage service',
  realtime: 'Realtime service',
  jwks: 'JWKS endpoint',
  'stack-uniqueness': 'Stack uniqueness',
  'ownership-proof': 'Stack ownership proof',
  'stack-identity-match': 'Stack identity match',
}

export function getFailedRequiredPreflightChecks(
  preflight: PreflightReportLike | null | undefined
): PreflightCheckLike[] {
  const checks = preflight?.checks ?? []
  return checks.filter((check) => check.status === 'fail' && check.required !== false)
}

function localizeCheckLabel(name: string): string {
  const label = PREFLIGHT_CHECK_LABELS[name] ?? name
  return $t(label)
}

function localizeMaybe(text: string | undefined): string {
  if (!text) return $t('failed')
  // Dynamic English messages from the server are the catalog keys.
  return $t(text)
}

/**
 * Returns a localized multi-line diagnostic when `error` is a preflight_failed payload.
 * Returns undefined for unrelated errors so callers can fall through to default handling.
 */
export function formatAttachmentPreflightError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const body = error as {
    code?: unknown
    message?: unknown
    preflight?: PreflightReportLike
  }
  if (body.code !== 'preflight_failed') return undefined

  const failed = getFailedRequiredPreflightChecks(body.preflight)
  const headlineSource =
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : 'Attachment preflight failed'
  const headline = $t(headlineSource)

  if (failed.length === 0) return headline

  const details = failed
    .map((check) => {
      const name = localizeCheckLabel(check.name)
      const message = localizeMaybe(check.message)
      const rem = check.remediation ? ` — ${localizeMaybe(check.remediation)}` : ''
      return `• ${name}: ${message}${rem}`
    })
    .join('\n')

  return `${headline}\n${details}`
}
