import { flattenOtelInspectionRow } from './otel-inspection.utils'
import { parseUnifiedLogsQueryRows } from './unified-logs.utils'
import { LOG_TYPE_TO_SOURCE } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.constants'

export function flattenSelfHostedInspection(value: unknown) {
  const row = parseUnifiedLogsQueryRows(value)[0]
  if (!row) return undefined
  const attributes: Record<string, string> = {}
  const visit = (value: unknown, prefix: string) => {
    if (Array.isArray(value)) {
      if (value.length === 1) visit(value[0], prefix)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        visit(child, prefix ? `${prefix}.${key}` : key)
    } else if (value !== null && value !== undefined) {
      attributes[prefix] = String(value)
    }
  }
  visit(row.metadata, '')
  attributes['request.method'] = row.method ?? ''
  attributes['request.path'] = row.pathname ?? ''
  attributes['response.status_code'] = String(row.status ?? '')
  const source = Object.entries(LOG_TYPE_TO_SOURCE).find(([type]) => type === row.log_type)?.[1]
  const entry = flattenOtelInspectionRow({
    id: row.id,
    timestamp: String(row.timestamp),
    source: source ?? '',
    event_message: row.event_message ?? '',
    severity_text: row.level ?? '',
    log_attributes: attributes,
  })
  return { ...entry, execution_id: attributes.execution_id, raw_log_data: row }
}
