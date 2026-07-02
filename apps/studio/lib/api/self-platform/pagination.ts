// [self-platform] Query-param validation for the paginated list routes.
// Returns the fallback when the param is absent, null when malformed
// (array-valued, non-integer, negative) — routes map null to 400.
export function parsePaginationParam(
  value: string | string[] | undefined,
  fallback: number
): number | null {
  if (value === undefined) return fallback
  if (Array.isArray(value)) return null
  if (!/^\d+$/.test(value)) return null
  return parseInt(value, 10)
}
