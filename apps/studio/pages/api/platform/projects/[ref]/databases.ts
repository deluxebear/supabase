import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { POSTGRES_PORT } from '@/lib/api/self-hosted/constants'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_DB_HOST, PROJECT_REST_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

type ResponseData =
  paths['/platform/projects/{ref}/databases']['get']['responses']['200']['content']['application/json']

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) {
    // Plain self-hosted: historical stub, unchanged (M1 leftover `cloud_provider: 'localhost' as
    // any` corrected to the legal 'AWS' enum member).
    const body: ResponseData = [
      {
        cloud_provider: 'AWS',
        connectionString: '',
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
    ]
    return res.status(200).json(body)
  }
  const ref = String(req.query.ref)
  try {
    const conn = await resolveProjectConnection(ref)
    const body: ResponseData = [
      {
        cloud_provider: 'AWS',
        connectionString: conn.pgConnEncrypted,
        connection_string_read_only: conn.pgConnReadOnlyEncrypted,
        db_host: conn.dbHost,
        db_name: conn.dbName,
        db_port: conn.dbPort,
        db_user: conn.dbUser,
        identifier: conn.ref,
        inserted_at: '2021-08-02T06:40:40.646Z',
        region: conn.region,
        restUrl: conn.restUrl,
        size: '',
        // [self-platform] narrows DB `text` -> the DatabaseDetailResponse status enum; sanctioned
        // `as X['status']` exception (not `as any`).
        status: conn.status as ResponseData[number]['status'],
      },
    ]
    return res.status(200).json(body)
  } catch (err) {
    if (err instanceof ProjectNotFound)
      return res.status(404).json({ message: 'Project not found' })
    throw err
  }
}
