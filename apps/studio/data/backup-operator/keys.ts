export const backupOperatorKeys = {
  cluster: (projectRef: string | undefined) =>
    ['projects', projectRef, 'backup-operator', 'cluster'] as const,
  pitr: (projectRef: string | undefined) =>
    ['projects', projectRef, 'backup-operator', 'pitr'] as const,
  plan: (projectRef: string | undefined, planId: string | undefined) =>
    ['projects', projectRef, 'backup-operator', 'restore-plans', planId] as const,
  policy: (projectRef: string | undefined) =>
    ['projects', projectRef, 'backup-operator', 'policy'] as const,
  backups: (projectRef: string | undefined) =>
    ['projects', projectRef, 'backup-operator', 'backups'] as const,
  job: (projectRef: string | undefined, jobId: string | undefined) =>
    ['projects', projectRef, 'backup-operator', 'jobs', jobId] as const,
}
