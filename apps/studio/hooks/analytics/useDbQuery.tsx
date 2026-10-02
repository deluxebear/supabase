import { type SafeSqlFragment } from '@supabase/pg-meta/src/pg-format'
import { useQuery } from '@tanstack/react-query'

import { DEFAULT_QUERY_PARAMS } from '@/components/interfaces/Reports/Reports.constants'
import {
  BaseReportParams,
  MetaQueryResponse,
  ReportQueryDb,
} from '@/components/interfaces/Reports/Reports.types'
import { useReadReplicasQuery } from '@/data/read-replicas/replicas-query'
import { executeSql } from '@/data/sql/execute-sql-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { IS_PLATFORM } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { useDatabaseSelectorStateSnapshot } from '@/state/database-selector'

export interface DbQueryHook<T = any> {
  isLoading: boolean
  isRefetching: boolean
  error: string
  data: T[]
  params: BaseReportParams
  logData?: never
  runQuery: () => void
  setParams?: never
  changeQuery?: never
  resolvedSql: string
}

/**
 * Whether a db query may run yet. On hosted platform we wait for the selected database's
 * connection string so a replica never silently falls back to the primary. Self-hosted and
 * self-platform deployments never return a connection string (executeSql resolves the
 * database from the project ref), so waiting for one would leave the query disabled forever.
 */
export const canRunDbQuery = ({
  isPlatform = IS_PLATFORM,
  isSelfPlatform = IS_SELF_PLATFORM,
  connectionString,
}: {
  isPlatform?: boolean
  isSelfPlatform?: boolean
  connectionString?: string | null
}) => !isPlatform || isSelfPlatform || Boolean(connectionString)

// [Joshen] Atm this is being used only in query performance
const useDbQuery = ({
  sql,
  params = DEFAULT_QUERY_PARAMS,
  where,
  orderBy,
}: {
  sql: ReportQueryDb['safeSql'] | SafeSqlFragment
  params?: BaseReportParams
  where?: string
  orderBy?: string
}): DbQueryHook => {
  const { data: project } = useSelectedProjectQuery()
  const state = useDatabaseSelectorStateSnapshot()

  const { data: databases } = useReadReplicasQuery({ projectRef: project?.ref })
  const connectionString = (databases || []).find(
    (db) => db.identifier === state.selectedDatabaseId
  )?.connection_string_read_only // default to using the read_only string
  const identifier = state.selectedDatabaseId

  // When a read-replica is selected, require its connection string before fetching.
  // Falling back to the primary's connection string would silently query the wrong database.
  const isPrimarySelected = !state.selectedDatabaseId || state.selectedDatabaseId === project?.ref
  const effectiveConnectionString = isPrimarySelected
    ? (connectionString ?? project?.connectionString)
    : connectionString

  const resolvedSql = typeof sql === 'function' ? sql([]) : sql

  const {
    data,
    error: rqError,
    isPending,
    isRefetching,
    refetch,
  } = useQuery({
    queryKey: [
      'projects',
      project?.ref,
      'db',
      { ...params, sql: resolvedSql, identifier, connectionString: effectiveConnectionString },
      where,
      orderBy,
    ],
    queryFn: ({ signal }) => {
      return executeSql(
        {
          projectRef: project?.ref,
          connectionString: effectiveConnectionString,
          sql: resolvedSql,
        },
        signal
      ).then((res) => res.result) as Promise<MetaQueryResponse>
    },
    // Don't run until we have a connection string for the selected database.
    // For replicas this prevents a silent fallback to the primary before replicas load.
    // Self-hosted and self-platform have no connection string — see canRunDbQuery.
    enabled: Boolean(resolvedSql) && canRunDbQuery({ connectionString: effectiveConnectionString }),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const error = rqError || (typeof data === 'object' ? data?.error : '')
  return {
    error,
    data,
    isLoading: isPending,
    isRefetching,
    params,
    runQuery: refetch,
    resolvedSql,
  }
}

export default useDbQuery
