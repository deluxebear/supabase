import { z } from 'zod'

const runtimeEventSchema = z
  .object({
    event_message: z.string(),
    event_type: z.string(),
    function_id: z.string(),
    execution_id: z.string(),
    level: z.string(),
  })
  .passthrough()

/** Restore Cloud-shaped fields from the PG Logflare transport envelope. */
export function decodeFunctionLogEnvelope(row: Record<string, unknown>, projectRef: string) {
  if (typeof row.event_message !== 'string') return row
  const parts = row.event_message.split(' | ')
  if (parts.length >= 9 && ['Boot', 'Shutdown', 'Log', 'UncaughtException'].includes(parts[0])) {
    try {
      const parsed = runtimeEventSchema.safeParse(JSON.parse(parts.slice(8).join(' | ')))
      if (!parsed.success) return row
      return { ...row, ...parsed.data, metadata: [parsed.data] }
    } catch {
      return row
    }
  }
  if (
    parts.length === 5 &&
    /^[A-Z]+$/.test(parts[0]) &&
    /^\d{3}$/.test(parts[1]) &&
    /^\/functions\/v1\/[A-Za-z0-9_-]+$/.test(parts[2]) &&
    parts[3] !== '' &&
    Number.isFinite(Number(parts[3])) &&
    Number(parts[3]) >= 0
  ) {
    const metadata = {
      function_id: `${projectRef}:${parts[2].split('/').pop()}`,
      execution_id: parts[4] || undefined,
      execution_time_ms: Number(parts[3]),
      request: { method: parts[0], pathname: parts[2] },
      response: { status_code: Number(parts[1]) },
    }
    return {
      ...row,
      event_message: parts.slice(0, 3).join(' | '),
      ...metadata,
      method: parts[0],
      pathname: parts[2],
      status_code: parts[1],
      metadata: [metadata],
    }
  }
  return row
}
