import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { constructHeaders, fetchHandler } from '@/data/fetchers'
import { BASE_PATH } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'
import { ResponseError, UseCustomMutationOptions } from '@/types'

type SqlTitleGenerateResponse = {
  title: string
  description: string
}

type SqlTitleGenerateVariables = {
  sql: string
}

async function generateSqlTitle({ sql }: SqlTitleGenerateVariables) {
  const url = `${BASE_PATH}/api/ai/sql/title-v2`

  const headers = await constructHeaders({ 'Content-Type': 'application/json' })
  const response = await fetchHandler(url, {
    headers,
    method: 'POST',
    body: JSON.stringify({
      sql,
    }),
  })
  let body: any

  try {
    body = await response.json()
  } catch {}

  if (!response.ok) {
    throw new ResponseError(body?.message, response.status)
  }

  return body as SqlTitleGenerateResponse
}

type SqlTitleGenerateData = Awaited<ReturnType<typeof generateSqlTitle>>

export const useSqlTitleGenerateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<SqlTitleGenerateData, ResponseError, SqlTitleGenerateVariables>,
  'mutationFn'
> = {}) => {
  return useMutation<SqlTitleGenerateData, ResponseError, SqlTitleGenerateVariables>({
    mutationFn: (vars) => generateSqlTitle(vars),
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to generate title: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
