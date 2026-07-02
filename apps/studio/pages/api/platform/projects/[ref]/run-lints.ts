import { NextApiRequest, NextApiResponse } from 'next'

import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { DEFAULT_EXPOSED_SCHEMAS } from '@/lib/api/self-hosted/constants'
import { getLints } from '@/lib/api/self-hosted/lints'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      try {
        const { data, error } = await getLints({
          headers: constructHeaders(req.headers),
          exposedSchemas: DEFAULT_EXPOSED_SCHEMAS,
          // [self-platform] Route lints at the selected project's DB.
          projectRef: IS_SELF_PLATFORM ? String(req.query.ref) : undefined,
        })
        if (error) {
          return res.status(400).json(error)
        } else {
          return res.status(200).json(data)
        }
      } catch (err) {
        if (err instanceof ProjectNotFound) {
          return res.status(404).json({ message: 'Project not found' })
        }
        throw err
      }
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}
