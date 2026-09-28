import { createFileRoute } from '@tanstack/react-router'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/auth/[ref]/config/apply'

const handler = toWebHandler(nextHandler)

export const Route = createFileRoute('/api/platform/auth/$ref/config/apply')({
  server: { handlers: { GET: handler, POST: handler } },
})
