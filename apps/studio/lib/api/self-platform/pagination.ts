// [self-platform] Query-param validation for the paginated list routes.
// Returns the fallback when the param is absent, null when malformed
// (array-valued, non-integer, negative) — routes map null to 400. A ceiling
// is opt-in via `max`: when provided, valid values above it are clamped (not
// rejected) to that ceiling. Callers should only pass `max` for `limit` —
// `offset` must stay unclamped or pages beyond `max` become unreachable.
export function parsePaginationParam(
  value: string | string[] | undefined,
  fallback: number,
  max?: number
): number | null {
  if (value === undefined) return fallback
  if (Array.isArray(value)) return null
  if (!/^\d+$/.test(value)) return null
  const parsed = parseInt(value, 10)
  return max !== undefined ? Math.min(parsed, max) : parsed
}
