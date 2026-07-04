// [self-platform] F9+F16 M4: GoTrue auth hooks PATCH (HOOK_* subset of the config
// store). PATCH-only; same UPDATE custom_config_gotrue gate as config.ts.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { writeHookConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type UpdateGoTrueConfigHooksBody = components['schemas']['UpdateGoTrueConfigHooksBody']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', ['PATCH'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)
  const body = (req.body ?? {}) as Partial<UpdateGoTrueConfigHooksBody>
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef: ref,
    resource: 'custom_config_gotrue',
  })
  if (!ok) return
  return res.status(200).json(await writeHookConfig(ref, body, claims?.sub))
}
