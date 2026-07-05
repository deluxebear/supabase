import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { toProjectDetailResponse } from '@/lib/api/self-platform/projects'
import { deleteProjectByRef } from '@/lib/api/self-platform/projects-admin'
import { checkPermission, guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method === 'GET') {
    if (!IS_SELF_PLATFORM) {
      // Plain self-hosted: historical stub, unchanged.
      return res
        .status(200)
        .json({ ...DEFAULT_PROJECT, connectionString: '', restUrl: PROJECT_REST_URL })
    }
    const ref = String(req.query.ref)
    try {
      const conn = await resolveProjectConnection(ref)
      // [self-platform] Visibility guard (spec §8): resolver 404 has already won
      // for unknown refs; a resolvable ref the member has no read grant on is 403.
      const canRead = await checkPermission(claims, {
        action: PermissionAction.READ,
        resource: 'projects',
        projectRef: ref,
      })
      if (!canRead) return res.status(403).json({ message: 'Forbidden' })
      // [self-platform] conn.row is the raw registry row (Task 4's ResolvedConnection.row) — a
      // registry hit maps through toProjectDetailResponse, the 'default' global-env fallback (no
      // row) shapes as DEFAULT_PROJECT with the resolved connection/rest URL. Avoids a second
      // getProjectByRef query.
      const base = conn.row
        ? toProjectDetailResponse(conn.row, conn.pgConnEncrypted)
        : { ...DEFAULT_PROJECT, connectionString: conn.pgConnEncrypted, restUrl: conn.restUrl }
      return res.status(200).json(base)
    } catch (err) {
      if (err instanceof ProjectNotFound)
        return res.status(404).json({ message: 'Project not found' })
      throw err
    }
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, claims)
  }
  res.setHeader('Allow', IS_SELF_PLATFORM ? ['GET', 'DELETE'] : ['GET'])
  return res
    .status(405)
    .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}

// [self-platform] M5.0 spec §5: deregister-ONLY — removes the registry row,
// never touches the real database. Order: ghost 404 (guard resolves first) →
// 403 (Owner-only via the matrix deny) → default-refusal 400 → business.
async function handleDelete(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.DELETE,
    projectRef: ref,
    resource: 'projects',
  })
  if (!ok) return
  if (ref === 'default') {
    return res.status(400).json({ message: 'The default project cannot be deleted' })
  }
  await deleteProjectByRef(ref)
  return res.status(200).json({ ref })
}
