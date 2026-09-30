import { z } from 'zod'

const payloadSchema = z.object({
  event_message: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
})

export function decodeUnifiedLogEnvelope(row: Record<string, unknown>) {
  if (typeof row.event_message !== 'string' || !row.event_message.startsWith('UnifiedLog | ')) {
    return row
  }
  const parts = row.event_message.split(' | ')
  try {
    const payload = payloadSchema.parse(JSON.parse(parts.slice(7).join(' | ')))
    return {
      ...row,
      self_hosted: true,
      log_type: parts[1],
      status: /^\d{3}$/.test(parts[2]) ? Number(parts[2]) : null,
      level: parts[3],
      method: parts[4] || null,
      pathname: parts[5]?.replaceAll('%20%7C%20', ' | ') || null,
      auth_user: parts[6] || null,
      event_message: payload.event_message,
      metadata: payload.metadata ?? {},
      log_count: null,
      logs: null,
    }
  } catch {
    return row
  }
}
