import { createFileRoute } from '@tanstack/react-router'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/database/[ref]/backup-operator/status'

const handler = toWebHandler(nextHandler)

export const Route = createFileRoute('/api/platform/database/$ref/backup-operator/status')({
  server: { handlers: { GET: handler } },
})
