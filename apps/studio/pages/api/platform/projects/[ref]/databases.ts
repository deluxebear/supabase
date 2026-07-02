import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { POSTGRES_PORT } from '@/lib/api/self-hosted/constants'
import { encryptString, getConnectionString } from '@/lib/api/self-hosted/util'
import { PROJECT_DB_HOST, PROJECT_REST_URL } from '@/lib/constants/api'
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

type ResponseData =
  paths['/platform/projects/{ref}/databases']['get']['responses']['200']['content']['application/json']

const handleGet = async (_req: NextApiRequest, res: NextApiResponse<ResponseData>) => {
  return res.status(200).json([
    {
      cloud_provider: 'localhost' as any,
      // [self-platform] SQLEditor.tsx's isValidConnString gate reads connectionString off THIS
      // list (databaseSelectorState.selectedDatabaseId → databases[].connectionString), not off
      // /platform/projects/{ref} directly — so it needs the same real encrypted connection
      // string as that sibling route's fix, or every SQL Editor query run fails client-side with
      // "Connection string is missing" before a request is even sent. Plain self-hosted
      // (self-platform off) keeps the historical ''.
      connectionString: IS_SELF_PLATFORM
        ? encryptString(getConnectionString({ readOnly: false }))
        : '',
      connection_string_read_only: '',
      db_host: PROJECT_DB_HOST,
      db_name: 'postgres',
      db_port: POSTGRES_PORT,
      db_user: 'postgres',
      identifier: 'default',
      inserted_at: '',
      region: 'local',
      restUrl: PROJECT_REST_URL,
      size: '',
      status: 'ACTIVE_HEALTHY',
    },
  ])
}
