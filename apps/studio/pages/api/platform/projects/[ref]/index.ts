import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { toProjectDetailResponse } from '@/lib/api/self-platform/projects'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) {
    // Plain self-hosted: historical stub, unchanged.
    return res
      .status(200)
      .json({ ...DEFAULT_PROJECT, connectionString: '', restUrl: PROJECT_REST_URL })
  }
  const ref = String(req.query.ref)
  try {
    const conn = await resolveProjectConnection(ref)
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
