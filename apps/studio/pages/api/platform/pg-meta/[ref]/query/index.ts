import { NextApiRequest, NextApiResponse } from 'next'

import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { executeQuery } from '@/lib/api/self-hosted/query'
import { PgMetaDatabaseError } from '@/lib/api/self-hosted/types'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  const { query } = req.body
  const headers = constructHeaders(req.headers)

  // [self-platform] Thread the route's ref through so self-platform builds
  // query the SELECTED project's DB, not the global/default one. Unknown ref
  // (self-platform only) maps to 404, consistent with Task 6/7's
  // resolveProjectConnection error handling.
  try {
    const { data, error } = await executeQuery({
      query,
      headers,
      projectRef: String(req.query.ref),
    })

    if (error) {
      if (error instanceof PgMetaDatabaseError) {
        const { statusCode, message, formattedError } = error
        return res.status(statusCode).json({ message, formattedError })
      }
      const { message } = error
      return res.status(500).json({ message, formattedError: message })
    } else {
      return res.status(200).json(data)
    }
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
