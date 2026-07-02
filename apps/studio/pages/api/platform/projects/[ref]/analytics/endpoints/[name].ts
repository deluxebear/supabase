import assert from 'node:assert'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { AnalyticsNotConfigured, retrieveAnalyticsData } from '@/lib/api/self-hosted/logs'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
    case 'POST': {
      const { name, ref, ...queryToForward } = req.query
      const params = req.method === 'GET' ? queryToForward : req.body

      assert(typeof ref === 'string', 'Invalid or missing ref parameter')
      assert(typeof name === 'string', 'Invalid or missing name parameter')

      try {
        const { data, error } = await retrieveAnalyticsData({ name, params, projectRef: ref })
        if (data) {
          return res.status(200).json(data)
        } else {
          return res.status(500).json({ error: { message: error.message } })
        }
      } catch (err) {
        // [self-platform] Registry miss / unconfigured analytics → 404.
        if (err instanceof ProjectNotFound) {
          return res.status(404).json({ message: 'Project not found' })
        }
        if (err instanceof AnalyticsNotConfigured) {
          return res.status(404).json({ message: 'Analytics is not configured for this project' })
        }
        throw err
      }
    }
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}
