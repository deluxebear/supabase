import { useMutation } from '@tanstack/react-query'
import { useFlag } from 'common'
import { toast } from 'sonner'

import { USE_LOGFLARE_PG_SQL } from './logflare-dialect'
import { logsAllEndpointUrl, pickLogsQueryBuilder } from './logs-endpoint'
import { getUnifiedLogsISOStartEnd } from './unified-logs-infinite-query'
import { mapUnifiedLogRow, parseUnifiedLogsQueryRows } from './unified-logs.utils'
import { getUnifiedLogsQuery } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.queries'
import { getUnifiedLogsQuery as getUnifiedLogsQueryBq } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.queries.bq'
import { getUnifiedLogsQuery as buildPgQuery } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.queries.pg'
import { QuerySearchParamsType } from '@/components/interfaces/UnifiedLogs/UnifiedLogs.types'
import { handleError, post } from '@/data/fetchers'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type getUnifiedLogsVariables = {
  projectRef: string
  search: QuerySearchParamsType
  limit: number
  hoursAgo?: number
  useOtel?: boolean
}

// [Joshen] Mainly for retrieving logs on demand for downloading
export async function retrieveUnifiedLogs({
  projectRef,
  search,
  limit,
  hoursAgo,
  useOtel = false,
}: getUnifiedLogsVariables) {
  if (typeof projectRef === 'undefined')
    throw new Error('projectRef is required for retrieveUnifiedLogs')

  const { isoTimestampStart, isoTimestampEnd } = getUnifiedLogsISOStartEnd(search, hoursAgo)
  const buildQuery = USE_LOGFLARE_PG_SQL
    ? buildPgQuery
    : pickLogsQueryBuilder(useOtel, getUnifiedLogsQuery, getUnifiedLogsQueryBq)
  const querySearch = USE_LOGFLARE_PG_SQL
    ? { ...search, date: [new Date(isoTimestampStart), new Date(isoTimestampEnd)] }
    : search
  const sql = `${buildQuery(querySearch)} ORDER BY timestamp DESC, id DESC LIMIT ${limit}`

  const endpoint = logsAllEndpointUrl(useOtel)
  const { data, error } = await post(endpoint, {
    params: { path: { ref: projectRef } },
    body: { iso_timestamp_start: isoTimestampStart, iso_timestamp_end: isoTimestampEnd, sql },
  })

  if (error) handleError(error)

  const resultData = parseUnifiedLogsQueryRows(data?.result)
  const result = resultData.map(mapUnifiedLogRow)

  return result
}

type LogDrainCreateData = Awaited<ReturnType<typeof retrieveUnifiedLogs>>

export const useGetUnifiedLogsMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<LogDrainCreateData, ResponseError, getUnifiedLogsVariables>,
  'mutationFn'
> = {}) => {
  const useOtel = useFlag('otelUnifiedLogs')
  return useMutation<LogDrainCreateData, ResponseError, getUnifiedLogsVariables>({
    mutationFn: (vars) => retrieveUnifiedLogs({ ...vars, useOtel: vars.useOtel ?? useOtel }),
    async onSuccess(data, variables, context) {
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to retrieve logs: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
