// [self-platform] Query-param validation for the paginated list routes.
// Returns the fallback when the param is absent, null when malformed
// (array-valued, non-integer, negative) — routes map null to 400. Valid
// values above 1000 are clamped (not rejected) to a ceiling of 1000.
export function parsePaginationParam(
  value: string | string[] | undefined,
  fallback: number
): number | null {
  if (value === undefined) return fallback
  if (Array.isArray(value)) return null
  if (!/^\d+$/.test(value)) return null
  return Math.min(parseInt(value, 10), 1000)
}
