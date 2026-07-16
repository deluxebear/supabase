import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  getBackupManagementAvailability,
  type BackupManagementAvailability,
} from '@/lib/api/self-platform/backup-management-availability'
import { requestBackupOperator } from '@/lib/api/self-platform/backup-operator-client'
import {
  getBackupOperatorStatus,
  unavailableBackupOperatorStatus,
} from '@/lib/api/self-platform/backup-operator-status'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ message: `Method ${req.method} Not Allowed` })
  }
  if (!IS_SELF_PLATFORM) return res.status(404).json({ message: 'Not found' })
  if (STUDIO_DEPLOYMENT_PROFILE === 'fleet' && !STUDIO_CAPABILITIES.backupManagement) {
    return res.status(404).json({ message: 'Not found' })
  }
  const projectRef = String(req.query.ref)
  const isAllowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef,
  })
  if (!isAllowed) return
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') {
    return res.status(200).json(await getBackupOperatorStatus(projectRef))
  }

  let management = await getBackupManagementAvailability(projectRef)
  res.setHeader('X-Correlation-ID', management.correlationId)

  if (management.state === 'checking' || management.state === 'available') {
    try {
      await requestBackupOperator(projectRef, '', {
        method: 'GET',
        actor: claims?.sub ?? 'studio-api',
        correlationId: management.correlationId,
      })
      management = { ...management, state: 'available', blockers: [] }
    } catch (error) {
      management = operatorFailureAvailability(management, error)
    }
  }

  if (management.state !== 'available') {
    return res.status(200).json({ ...unavailableBackupOperatorStatus, management })
  }
  return res.status(200).json({ ...(await getBackupOperatorStatus(projectRef)), management })
}

function operatorFailureAvailability(
  current: BackupManagementAvailability,
  error: unknown
): BackupManagementAvailability {
  const incompatible =
    error instanceof Error &&
    ('status' in error ? Number(error.status) === 426 : /incompatible/i.test(error.message))
  return {
    ...current,
    state: incompatible ? 'incompatible' : 'offline',
    blockers: [
      {
        code: incompatible ? 'backup_domain_incompatible' : 'backup_domain_offline',
        message: incompatible
          ? 'The Backup Operator domain is not compatible with this Studio release.'
          : 'The configured Backup Operator domain did not pass its readiness check.',
        remediation: incompatible
          ? 'Upgrade Studio and the Backup Operator to a compatible contract version.'
          : 'Check the management target, Agent connection, TLS trust, and Operator health.',
      },
    ],
  }
}
