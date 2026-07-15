import { createFileRoute } from '@tanstack/react-router'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/organizations/[slug]/management-targets/[targetId]'

const handler = toWebHandler(nextHandler)

export const Route = createFileRoute(
  '/api/platform/organizations/$slug/management-targets/$targetId'
)({
  server: { handlers: { GET: handler, DELETE: handler } },
})
