import type { OperatorJobData } from './backup-operator-query'

export const isActiveBackupOperatorJob = (state: OperatorJobData['state'] | undefined): boolean =>
  state === 'queued' || state === 'running'
