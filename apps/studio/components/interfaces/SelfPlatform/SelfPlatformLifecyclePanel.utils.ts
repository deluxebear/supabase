import type { LifecycleAction } from '@/lib/api/self-platform/lifecycle-contract'

type Action = LifecycleAction
export function lifecycleParameters(action: Action, value: string, replicas: number) {
  if (action === 'runtime.restart' || action === 'runtime.rollout') return { service: value }
  if (action === 'runtime.scale') return { service: value, replicas }
  if (action === 'postgres.upgrade.plan' || action === 'postgres.upgrade.execute')
    return { targetVersion: value }
  if (action === 'replica.create' || action === 'replica.remove') return { replicaName: value }
  if (action === 'branch.create') return { branchName: value, sourceBranch: 'main' }
  if (action === 'branch.restore') return { branchName: value }
  if (action === 'network.bans.update')
    return {
      bannedNetworks: value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    }
  return {}
}

export function lifecycleValueLabel(action: Action) {
  if (action.startsWith('runtime.')) return 'Service'
  if (action.startsWith('postgres.upgrade')) return 'Target PostgreSQL version'
  if (action.startsWith('replica.')) return 'Replica name'
  if (action.startsWith('branch.')) return 'Branch name'
  if (action === 'network.bans.update') return 'Banned IPs or CIDRs'
  return null
}
