import { randomUUID } from 'node:crypto'

import type { BackupManagementAvailability } from './backup-management-availability-schema'
import { getProjectManagementBinding, type ManagementBinding } from './management-trust'

export type { BackupManagementAvailability } from './backup-management-availability-schema'

type AvailabilityBinding = Pick<
  ManagementBinding,
  'state' | 'targetState' | 'allowedCapabilityPrefixes' | 'domains'
>

const availability = (
  correlationId: string,
  state: BackupManagementAvailability['state'],
  configured: boolean,
  blocker?: BackupManagementAvailability['blockers'][number]
): BackupManagementAvailability => ({
  state,
  configured,
  blockers: blocker ? [blocker] : [],
  correlationId,
})

export function evaluateBackupManagementAvailability(
  binding: AvailabilityBinding | null,
  correlationId: string
): BackupManagementAvailability {
  if (!binding) {
    return availability(correlationId, 'unconfigured', false, {
      code: 'backup_management_unconfigured',
      message: 'This project is not bound to a Backup Operator management domain.',
      remediation: 'Add a Backup Operator domain to a management target, then bind this project.',
    })
  }

  const domain = binding.domains.find((item) => item.domain === 'backup-operator')
  if (!domain) {
    return availability(correlationId, 'unconfigured', false, {
      code: 'backup_domain_unconfigured',
      message: 'The bound management target does not provide a Backup Operator domain.',
      remediation: 'Add the Backup Operator domain to the management target.',
    })
  }

  if (!binding.allowedCapabilityPrefixes.includes('backup.')) {
    return availability(correlationId, 'unauthorized', true, {
      code: 'backup_capability_not_allowed',
      message: 'The project binding does not allow Backup capabilities.',
      remediation: 'Rebind the project with the backup. capability prefix.',
    })
  }

  if (binding.state === 'incompatible' || domain.state === 'incompatible') {
    return availability(correlationId, 'incompatible', true, {
      code: 'backup_domain_incompatible',
      message: 'The Backup Operator domain is not compatible with this Studio release.',
      remediation: 'Upgrade Studio and the Backup Operator to a compatible contract version.',
    })
  }

  if (
    binding.targetState !== 'active' ||
    ['offline', 'revoking', 'revoked'].includes(binding.state) ||
    domain.state === 'revoked'
  ) {
    return availability(correlationId, 'offline', true, {
      code: 'backup_domain_offline',
      message: 'The configured Backup Operator domain is offline.',
      remediation: 'Check the management target, Agent connection, TLS trust, and Operator health.',
    })
  }

  if (
    binding.state !== 'active' ||
    domain.state === 'unverified' ||
    domain.state === 'unavailable'
  ) {
    return availability(correlationId, 'checking', true, {
      code:
        domain.state === 'unavailable' ? 'backup_domain_rechecking' : 'backup_domain_unverified',
      message:
        domain.state === 'unavailable'
          ? 'The Backup Operator domain was unavailable and is being checked again.'
          : 'The Backup Operator domain has not completed a successful readiness check.',
      remediation:
        domain.state === 'unavailable'
          ? 'Keep the Operator reachable while the readiness check runs.'
          : 'Complete Agent enrollment and refresh the management binding.',
    })
  }

  return availability(correlationId, 'available', true)
}

export async function getBackupManagementAvailability(
  projectRef: string,
  correlationId = randomUUID()
): Promise<BackupManagementAvailability> {
  const binding = await getProjectManagementBinding(projectRef)
  return evaluateBackupManagementAvailability(binding, correlationId)
}
