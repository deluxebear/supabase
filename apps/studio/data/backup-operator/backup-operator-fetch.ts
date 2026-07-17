import { constructHeaders } from '@/data/fetchers'
import { ResponseError } from '@/types'

/**
 * All browser-to-Studio Backup Operator requests cross the authenticated BFF.
 * Keep token propagation in one place so status, inventory, policy, jobs,
 * restore operations, and event replay cannot drift onto different auth modes.
 */
export async function fetchBackupOperator(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch
) {
  const headers = await constructHeaders(init.headers)
  return fetcher(input, { ...init, headers })
}

export function retryBackupOperatorQuery(failureCount: number, error: Error) {
  if (error instanceof ResponseError && (error.code === 401 || error.code === 403)) return false
  // Contract drift is deterministic. Surface it immediately instead of
  // hiding it behind transient transport retry backoff.
  if (error.name === 'ZodError') return false
  return failureCount < 2
}
