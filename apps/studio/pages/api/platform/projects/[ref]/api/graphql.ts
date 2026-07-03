import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handleGet(req, res)

    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  let gqlUrl = `${process.env.SUPABASE_URL}/graphql/v1`
  let apikey = process.env.SUPABASE_SERVICE_KEY!
  let anonKey = process.env.SUPABASE_ANON_KEY
  if (IS_SELF_PLATFORM) {
    try {
      const conn = await resolveProjectConnection(String(req.query.ref))
      if (conn.row) {
        gqlUrl = `${conn.supabaseUrl}/graphql/v1`
        apikey = conn.serviceKey
        anonKey = conn.anonKey ?? undefined
      }
    } catch (err) {
      if (err instanceof ProjectNotFound) {
        return res.status(404).json({ message: 'Project not found' })
      }
      throw err
    }
  }
  const authorizationHeader = req.headers['x-graphql-authorization']
  const response = await fetch(gqlUrl, {
    method: 'POST',
    headers: {
      apikey,
      Authorization:
        (Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader) ??
        `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  })
  if (response.ok) {
    const data = await response.json()

    return res.status(200).json(data)
  }

  return res.status(500).json({ error: { message: 'Internal Server Error' } })
}
