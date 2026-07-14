import type { z } from 'zod'

import type {
  operatorJobSchema,
  restorePlanSchema,
} from '@/lib/api/self-platform/backup-operator-client'

type RestorePlan = z.infer<typeof restorePlanSchema>
type OperatorJob = z.infer<typeof operatorJobSchema>

export function canExecuteRestore(plan: RestorePlan | null, enteredHash: string) {
  return plan !== null && plan.blockers.length === 0 && enteredHash === plan.hash
}

export function canRollbackRestore(job: OperatorJob | undefined, now: Date) {
  if (!job?.rollbackUntil || job.state !== 'rollback-available') return false
  return now.getTime() < new Date(job.rollbackUntil).getTime()
}

export function getAAL2UpgradePath(hasMfaFactor: boolean) {
  return hasMfaFactor ? '/sign-in-mfa' : '/account/security'
}
