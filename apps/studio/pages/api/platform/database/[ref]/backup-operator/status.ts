import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { getBackupOperatorStatus } from '@/lib/api/self-platform/backup-operator-status'
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
  if (STUDIO_DEPLOYMENT_PROFILE === 'fleet') {
    try {
      await requireProjectCapability(projectRef, 'management.agent.connect')
    } catch (error) {
      if (error instanceof CapabilityUnavailable) {
        return res.status(409).json({
          code: 'capability_unavailable',
          message: error.message,
          blockers: error.blockers,
        })
      }
      throw error
    }
  }
  return res.status(200).json(await getBackupOperatorStatus(projectRef))
}
