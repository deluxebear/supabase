import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  applyRevealToApiKey,
  getNonPlatformApiKeys,
  parseRevealQuery,
} from '@/lib/api/self-hosted/api-keys'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const reveal = parseRevealQuery(req.query.reveal)

  // [self-platform] Resolve the registry project by ref so multi-project
  // deployments return the right keys. Plain self-hosted keeps the
  // historical global-env path (getNonPlatformApiKeys() with no arg).
  if (!IS_SELF_PLATFORM) {
    const response = getNonPlatformApiKeys().map((key) => applyRevealToApiKey(key, reveal))
    return res.status(200).json(response)
  }

  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    const response = getNonPlatformApiKeys(conn).map((key) => applyRevealToApiKey(key, reveal))
    return res.status(200).json(response)
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
