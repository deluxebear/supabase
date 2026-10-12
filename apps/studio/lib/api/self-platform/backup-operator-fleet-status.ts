import { z } from 'zod'

import {
  unavailableBackupOperatorStatus,
  type BackupOperatorStatus,
} from './backup-operator-status.shared'

// [self-platform] In the Fleet profile the Backup Operator serves each project
// from its backup Agent's observations, and nothing publishes a status row in
// the project database. Studio builds the status from the Operator's cluster
// (with discovery) and backup policy instead.
const clusterSchema = z.object({
  discovery: z
    .object({
      provider: z.string(),
      providerVersion: z.string().optional(),
      topology: z.string(),
      primary: z.string().optional(),
      standbys: z.array(z.string()).nullable().optional(),
      repositoryType: z.string().optional(),
      repositoryLocation: z.string().optional(),
      blockers: z.array(z.string()).nullable().optional(),
      observedAt: z.string(),
    })
    .nullable()
    .optional(),
})

const policySchema = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().int().positive().nullable().optional(),
  fullSchedule: z.string().nullable().optional(),
  backupFrom: z.enum(['primary', 'standby']).nullable().optional(),
})

/**
 * Status of a registered cluster. `discoveryError` is the Operator's message
 * when it has no recent observation from the Agent.
 */
export function fleetBackupOperatorStatus(
  cluster: unknown,
  policy: unknown,
  discoveryError?: string
): BackupOperatorStatus {
  const discovery = clusterSchema.parse(cluster ?? {}).discovery ?? null
  const parsedPolicy = policy == null ? null : policySchema.parse(policy)
  const blockers = discovery
    ? (discovery.blockers ?? [])
    : [discoveryError ?? 'The backup Agent has not reported the database state recently']
  return {
    ...unavailableBackupOperatorStatus,
    configured: true,
    policy: parsedPolicy
      ? {
          enabled: parsedPolicy.enabled,
          retentionDays: parsedPolicy.retentionDays ?? null,
          schedule: parsedPolicy.fullSchedule ?? null,
          backupFrom: parsedPolicy.backupFrom ?? null,
        }
      : unavailableBackupOperatorStatus.policy,
    provider: {
      name: discovery?.provider ?? 'pgBackRest',
      version: discovery?.providerVersion ?? null,
    },
    topology: {
      kind: discovery?.topology ?? 'unknown',
      primary: discovery?.primary ?? null,
      standbys: discovery?.standbys?.length ?? 0,
    },
    repository: {
      type: discovery?.repositoryType ?? null,
      location: discovery?.repositoryLocation ?? null,
    },
    check: {
      status: discovery && blockers.length === 0 ? 'healthy' : 'degraded',
      checkedAt: discovery?.observedAt ?? null,
      message: blockers.length > 0 ? blockers.join('; ') : null,
    },
    capabilities: {
      backup: discovery !== null,
      restore: discovery !== null && blockers.length === 0,
      blockers,
    },
    compatibility: { image: null, supported: true, blocker: null },
    updatedAt: discovery?.observedAt ?? null,
  }
}
