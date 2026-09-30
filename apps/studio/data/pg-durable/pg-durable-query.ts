import { literal, safeSql } from '@supabase/pg-meta'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { pgDurableKeys } from './keys'
import {
  durableConfigurationSchema,
  durableDetailSchema,
  durableInstanceSchema,
  durableMetricsSchema,
  type DurableStatus,
} from './pg-durable.types'
import { executeSql } from '@/data/sql/execute-sql-mutation'
import type { ResponseError } from '@/types'

export type PgDurableVariables = { projectRef?: string; connectionString?: string | null }
export type PgDurableError = ResponseError

async function getConfiguration(variables: PgDurableVariables, signal?: AbortSignal) {
  const { result } = await executeSql<unknown>(
    {
      ...variables,
      sql: safeSql`
    SELECT df.version() AS version, current_user AS role,
      has_function_privilege(current_user, 'df.start(text,text,text,text)', 'EXECUTE')
        AND (NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
          OR COALESCE(current_setting('pg_durable.enable_superuser_instances', true), 'off') = 'on') AS can_start,
      has_function_privilege(current_user, 'df.signal(text,text,text)', 'EXECUTE') AS can_signal,
      has_function_privilege(current_user, 'df.cancel(text,text)', 'EXECUTE') AS can_cancel,
      has_function_privilege(current_user, 'df.metrics()', 'EXECUTE') AS can_metrics,
      'pg_durable' = ANY(string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ',')) AS preloaded,
      current_setting('pg_durable.database', true) AS database,
      current_database() AS current_database,
      current_setting('pg_durable.worker_role', true) AS worker_role,
      current_setting('pg_durable.retention_days', true) AS retention_days,
      current_setting('pg_durable.reconcile_interval', true) AS reconcile_interval;
  `,
    },
    signal
  )
  return z.array(durableConfigurationSchema).nonempty().parse(result)[0]
}
export type PgDurableConfigurationData = Awaited<ReturnType<typeof getConfiguration>>
export const durableConfigurationQueryOptions = ({
  projectRef,
  connectionString,
}: PgDurableVariables) =>
  queryOptions({
    queryKey: pgDurableKeys.configuration(projectRef, connectionString),
    queryFn: ({ signal }) => getConfiguration({ projectRef, connectionString }, signal),
    enabled: !!projectRef,
    staleTime: 30_000,
  })

async function getMetrics(variables: PgDurableVariables, signal?: AbortSignal) {
  const { result } = await executeSql<unknown>(
    { ...variables, sql: safeSql`SELECT * FROM df.metrics();` },
    signal
  )
  return z.array(durableMetricsSchema).nonempty().parse(result)[0]
}
export type PgDurableMetricsData = Awaited<ReturnType<typeof getMetrics>>
export const durableMetricsQueryOptions = ({ projectRef, connectionString }: PgDurableVariables) =>
  queryOptions({
    queryKey: pgDurableKeys.metrics(projectRef, connectionString),
    queryFn: ({ signal }) => getMetrics({ projectRef, connectionString }, signal),
    enabled: !!projectRef,
    refetchInterval: 10_000,
  })

export type PgDurableInstancesVariables = PgDurableVariables & {
  status?: DurableStatus
  label?: string
  cursor?: string
}
async function getInstances(
  { status, label, cursor, ...variables }: PgDurableInstancesVariables,
  signal?: AbortSignal
) {
  const { result } = await executeSql<unknown>(
    {
      ...variables,
      sql: safeSql`
    SELECT * FROM df.list_instances(${literal(status ?? null)}::text, 50,
      ${literal(label || null)}::text, ${literal(cursor || null)}::text);
  `,
    },
    signal
  )
  return z.array(durableInstanceSchema).parse(result)
}
export type PgDurableInstancesData = Awaited<ReturnType<typeof getInstances>>
export const durableInstancesQueryOptions = ({
  projectRef,
  connectionString,
  status,
  label,
  cursor,
}: PgDurableInstancesVariables) =>
  queryOptions({
    queryKey: pgDurableKeys.instances(projectRef, status, label, cursor, connectionString),
    queryFn: ({ signal }) =>
      getInstances({ projectRef, connectionString, status, label, cursor }, signal),
    enabled: !!projectRef,
    refetchInterval: 5_000,
  })

export type PgDurableDetailVariables = PgDurableVariables & { instanceId?: string }
async function getDetail(
  { instanceId, ...variables }: PgDurableDetailVariables,
  signal?: AbortSignal
) {
  if (!instanceId) throw new Error('Instance ID is required')
  const { result } = await executeSql<unknown>(
    {
      ...variables,
      sql: safeSql`
    SELECT jsonb_build_object(
      'info', (SELECT to_jsonb(i) FROM df.instance_info(${literal(instanceId)}) i LIMIT 1),
      'nodes', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.node_id) FROM df.instance_nodes(${literal(instanceId)}) n), '[]'::jsonb),
      'executions', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.execution_id DESC) FROM df.instance_executions(${literal(instanceId)}, 20) e), '[]'::jsonb)
    ) AS detail;
  `,
    },
    signal
  )
  return z
    .array(z.object({ detail: durableDetailSchema }))
    .nonempty()
    .parse(result)[0].detail
}
export type PgDurableDetailData = Awaited<ReturnType<typeof getDetail>>
export const durableDetailQueryOptions = ({
  projectRef,
  connectionString,
  instanceId,
}: PgDurableDetailVariables) =>
  queryOptions({
    queryKey: pgDurableKeys.instance(projectRef, instanceId, connectionString),
    queryFn: ({ signal }) => getDetail({ projectRef, connectionString, instanceId }, signal),
    enabled: !!projectRef && !!instanceId,
    refetchInterval: (query) => {
      const status = query.state.data?.info?.status?.toLowerCase()
      return !query.state.data?.info || status === 'pending' || status === 'running' ? 3_000 : false
    },
  })
