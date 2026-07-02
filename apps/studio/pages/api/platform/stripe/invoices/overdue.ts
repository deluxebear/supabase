// [self-platform] Contract-minimal stub: self-platform has no Stripe billing
// integration (M1), so there is never an overdue invoice to report. Typed
// against api-types so upstream contract changes surface at compile time.
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

type OverdueInvoicesResponse =
  paths['/platform/stripe/invoices/overdue']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response: OverdueInvoicesResponse = []
  return res.status(200).json(response)
}
