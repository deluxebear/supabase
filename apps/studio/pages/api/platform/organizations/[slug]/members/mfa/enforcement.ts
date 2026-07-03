// [self-platform] Org MFA-enforcement flag (M3.1). The flag is stored and
// served; ACTUAL enforcement (blocking members without verified MFA) lands
// with the M3.2 invite/join flow — README states this honestly. PATCH gate
// mirrors SecuritySettings.tsx exactly: write:Update on organizations, which
// the matrix restricts to Owner (Administrator carries a restrictive deny on
// organization writes). Contract note: api-types puts both GET and PATCH
// responses on 201 (MfaController), so 201 it is.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getOrgMfaEnforced, setOrgMfaEnforced } from '@/lib/api/self-platform/organizations'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type MfaStatusResponse = components['schemas']['MfaStatusResponse']
type ChangeMFAEnforcementStateRequest = components['schemas']['ChangeMFAEnforcementStateRequest']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// exported for handler-level tests
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
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ message: 'Invalid slug parameter' })
  }
  const slug = String(req.query.slug)

  if (req.method === 'GET') {
    const org = await guardOrgRoute(res, claims, {
      slug,
      action: PermissionAction.READ,
      resource: 'organizations',
    })
    if (!org) return
    const response: MfaStatusResponse = { enforced: await getOrgMfaEnforced(org.orgId) }
    return res.status(201).json(response)
  }

  const body = (req.body ?? {}) as Partial<ChangeMFAEnforcementStateRequest>
  if (typeof body.enforced !== 'boolean') {
    return res.status(400).json({ message: 'Invalid enforced parameter' })
  }
  const org = await guardOrgRoute(res, claims, {
    slug,
    action: PermissionAction.UPDATE,
    resource: 'organizations',
  })
  if (!org) return
  await setOrgMfaEnforced(org.orgId, body.enforced)
  const response: MfaStatusResponse = { enforced: body.enforced }
  return res.status(201).json(response)
}
