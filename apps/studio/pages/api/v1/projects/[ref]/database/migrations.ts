import { NextApiRequest, NextApiResponse } from 'next'

import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { applyAndTrackMigrations, listMigrationVersions } from '@/lib/api/self-hosted/migrations'
import { PgMetaDatabaseError } from '@/lib/api/self-hosted/types'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const headers = constructHeaders(req.headers)
  const projectRef = IS_SELF_PLATFORM ? String(req.query.ref) : undefined

  try {
    // [self-platform] Fixes a pre-existing bug: this used to call
    // `listMigrationVersions(headers)`, passing the headers object AS the
    // options object, so `options.headers` was always undefined and headers
    // were silently dropped. Threading projectRef forces touching this call
    // anyway; correct it to the options-object form at the same time.
    const { data, error } = await listMigrationVersions({ headers, projectRef })

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

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  const headers = constructHeaders(req.headers)
  const { query, name } = req.body
  const projectRef = IS_SELF_PLATFORM ? String(req.query.ref) : undefined

  try {
    const { data, error } = await applyAndTrackMigrations({ query, name, headers, projectRef })

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
