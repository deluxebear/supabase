import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { encryptString, getConnectionString } from '@/lib/api/self-hosted/util'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (_req: NextApiRequest, res: NextApiResponse) => {
  // Platform specific endpoint
  const response = {
    ...DEFAULT_PROJECT,
    // [self-platform] The client-side `isValidConnString` gate blocks every pg-meta request when
    // IS_PLATFORM=true and this is falsy, and some pg-meta routes forward it verbatim as the
    // `x-connection-encrypted` header, so it must be a real encrypted connection string here (not
    // just a truthy placeholder). Plain self-hosted (self-platform off) keeps the historical ''.
    connectionString: IS_SELF_PLATFORM
      ? encryptString(getConnectionString({ readOnly: false }))
      : '',
    restUrl: PROJECT_REST_URL,
  }

  return res.status(200).json(response)
}
