// [self-platform] F9+F16 M4: per-project GoTrue config GET/PATCH. Self-platform
// only (no plain-mode target) — top-level 404 like the MFA-enforcement route,
// NOT the recover.ts per-ref proxy pattern. Secrets are always masked on GET.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { readAuthConfig, writeAuthConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type UpdateGoTrueConfigBody = components['schemas']['UpdateGoTrueConfigBody']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', ['GET', 'PATCH'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)

  if (req.method === 'GET') {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.READ,
      projectRef: ref,
      resource: 'custom_config_gotrue',
    })
    if (!ok) return
    return res.status(200).json(await readAuthConfig(ref))
  }

  const body = (req.body ?? {}) as Partial<UpdateGoTrueConfigBody>
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef: ref,
    resource: 'custom_config_gotrue',
  })
  if (!ok) return
  return res.status(200).json(await writeAuthConfig(ref, body, claims?.sub))
}
