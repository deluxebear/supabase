import { createFileRoute } from '@tanstack/react-router'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/fleet/v1/projects/[ref]/functions'

const handler = toWebHandler(nextHandler)

export const Route = createFileRoute('/api/platform/fleet/v1/projects/$ref/functions/')({
  server: { handlers: { GET: handler, POST: handler, DELETE: handler } },
})
