import type { z } from 'zod'

import type { operatorJobSchema, restorePlanSchema } from '@/data/backup-operator/schemas'
import { t as $t } from '@/lib/i18n'

type RestorePlan = z.infer<typeof restorePlanSchema>
type OperatorJob = z.infer<typeof operatorJobSchema>
type DrillStatus = 'none' | 'verified' | 'failed' | 'older-than-latest-backup' | 'mismatch'

export function isRestorePlanExpired(plan: RestorePlan | null, now: Date) {
  return plan !== null && now.getTime() >= new Date(plan.expiresAt).getTime()
}

export function canExecuteRestore(plan: RestorePlan | null, enteredHash: string, now: Date) {
  return (
    plan !== null &&
    !isRestorePlanExpired(plan, now) &&
    plan.blockers.length === 0 &&
    enteredHash === plan.hash
  )
}

export function canRollbackRestore(job: OperatorJob | undefined, now: Date) {
  if (!job?.rollbackUntil || job.state !== 'rollback-available') return false
  return now.getTime() < new Date(job.rollbackUntil).getTime()
}

export function getAAL2UpgradePath(hasMfaFactor: boolean) {
  return hasMfaFactor ? '/sign-in-mfa' : '/account/security'
}

/** Explains why the recovery window is not verified by a restore drill, or null when it is. */
export function getDrillStatusMessage(status: DrillStatus): string | null {
  switch (status) {
    case 'verified':
      return null
    case 'none':
      return $t('No restore drill has verified the latest backup yet.')
    case 'failed':
      return $t(
        'The last restore drill failed. Check the drill result before relying on this backup.'
      )
    case 'older-than-latest-backup':
      return $t(
        'The last restore drill verified an older backup. A drill for the latest backup runs automatically.'
      )
    case 'mismatch':
      return $t('The last restore drill does not match the current backup or repository.')
  }
}
