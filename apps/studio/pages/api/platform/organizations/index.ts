import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { listOrganizations, toOrganizationResponse } from '@/lib/api/self-platform/organizations'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) return handleLegacyGetAll(req, res)

  const rows = await listOrganizations()
  return res.status(200).json(rows.map(toOrganizationResponse))
}

// Plain self-hosted keeps the historical stub payload untouched.
const handleLegacyGetAll = async (_req: NextApiRequest, res: NextApiResponse) => {
  const response = [
    {
      id: 1,
      name: process.env.DEFAULT_ORGANIZATION_NAME || 'Default Organization',
      slug: 'default-org-slug',
      billing_email: 'billing@supabase.co',
      plan: { id: 'enterprise', name: 'Enterprise' },
    },
  ]
  return res.status(200).json(response)
}
