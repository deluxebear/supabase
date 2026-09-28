// The fields of an apply status that decide the notice. Auth settings and Edge
// Function secrets share them.
export type ConfigApplyNoticeStatus = {
  state: 'nothing-to-apply' | 'pending' | 'applying' | 'applied' | 'failed'
  availability: { isAvailable: true } | { isAvailable: false; message: string }
  operation: { errorCode: string | null } | null
}

export type ConfigApplyNotice =
  | { kind: 'hidden' }
  | { kind: 'saved-only'; reason: string | null }
  | { kind: 'pending' }
  | { kind: 'applying' }
  | { kind: 'failed'; errorCode: string | null }

/**
 * Chooses what a settings page says about the running service. Without a
 * status (loading or failed request) it falls back to the conservative
 * "saved, not applied" message.
 */
export function getConfigApplyNotice(
  status: ConfigApplyNoticeStatus | undefined
): ConfigApplyNotice {
  if (status === undefined) return { kind: 'saved-only', reason: null }
  if (status.state === 'applied' || status.state === 'nothing-to-apply') return { kind: 'hidden' }
  if (status.state === 'applying') return { kind: 'applying' }
  if (!status.availability.isAvailable) {
    return { kind: 'saved-only', reason: status.availability.message }
  }
  if (status.state === 'failed') {
    return { kind: 'failed', errorCode: status.operation?.errorCode ?? null }
  }
  return { kind: 'pending' }
}
