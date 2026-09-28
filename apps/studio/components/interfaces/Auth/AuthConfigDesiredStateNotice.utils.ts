import type { AuthConfigApplyStatus } from '@/data/auth/auth-config-apply'

export type AuthApplyNotice =
  | { kind: 'hidden' }
  | { kind: 'saved-only'; reason: string | null }
  | { kind: 'pending' }
  | { kind: 'applying' }
  | { kind: 'failed'; errorCode: string | null }

/**
 * Chooses what the Auth configuration pages say about the running Auth
 * service. Without a status (loading or failed request) the pages fall back
 * to the conservative "saved, not applied" message.
 */
export function getAuthApplyNotice(status: AuthConfigApplyStatus | undefined): AuthApplyNotice {
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
