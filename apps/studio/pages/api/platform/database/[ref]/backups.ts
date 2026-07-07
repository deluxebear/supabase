// [self-platform] Under management-plane self-platform, observe an
// operator-deployed pgBackRest state (RBAC READ, honest-empty on failure).
// Plain self-hosted keeps the M1 static stub — no managed backup system.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getProjectBackups } from '@/lib/api/self-platform/backups'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type BackupsResponse =
  paths['/platform/database/{ref}/backups']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  if (IS_SELF_PLATFORM) {
    const ref = String(req.query.ref)
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.READ,
      projectRef: ref,
    })
    if (!ok) return
    const response = await getProjectBackups(ref)
    return res.status(200).json(response)
  }

  // Plain self-hosted: M1 static stub — no managed backup system.
  const response: BackupsResponse = {
    backups: [],
    physicalBackupData: {},
    pitr_enabled: false,
    region: 'local',
    walg_enabled: false,
  }
  return res.status(200).json(response)
}
