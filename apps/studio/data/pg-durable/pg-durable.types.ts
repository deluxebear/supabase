import { z } from 'zod'

export const durableStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type DurableStatus = z.infer<typeof durableStatusSchema>

export const durableInstanceSchema = z.object({
  instance_id: z.string(),
  label: z.string().nullable(),
  function_name: z.string().nullable(),
  status: z.string().nullable(),
  execution_count: z.coerce.number(),
  output: z.string().nullable(),
  created_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  next_cursor: z.string().nullable(),
})
export type DurableInstance = z.infer<typeof durableInstanceSchema>

export const durableConfigurationSchema = z.object({
  version: z.string(),
  role: z.string(),
  can_start: z.boolean(),
  can_signal: z.boolean(),
  can_cancel: z.boolean(),
  can_metrics: z.boolean(),
  preloaded: z.boolean(),
  database: z.string().nullable(),
  current_database: z.string().nullable(),
  worker_role: z.string().nullable(),
  retention_days: z.string().nullable(),
  reconcile_interval: z.string().nullable(),
  installed_version: z.string().nullable(),
  default_version: z.string().nullable(),
  can_explain: z.boolean(),
  log_workflow_sql: z.string().nullable(),
  host: z.string().nullable(),
  max_new_transaction_starts: z.string().nullable(),
  new_transaction_start_timeout: z.string().nullable(),
  list_instances_max_limit: z.string().nullable(),
  enable_superuser_instances: z.string().nullable(),
  max_user_connections: z.string().nullable(),
  max_management_connections: z.string().nullable(),
  max_duroxide_connections: z.string().nullable(),
  execution_acquire_timeout: z.string().nullable(),
})
export type DurableConfiguration = z.infer<typeof durableConfigurationSchema>

export const durableMetricsSchema = z.object({
  total_instances: z.coerce.number(),
  running_instances: z.coerce.number(),
  completed_instances: z.coerce.number(),
  failed_instances: z.coerce.number(),
})

export const durableNodeSchema = z.object({
  node_id: z.string(),
  node_type: z.string(),
  query: z.string().nullable(),
  result_name: z.string().nullable(),
  left_node: z.string().nullable(),
  right_node: z.string().nullable(),
  status: z.string().nullable(),
  result: z.string().nullable(),
  status_details: z.string().nullable(),
  inferred_status: z.string().nullable(),
  updated_at: z.string().nullable(),
})
export type DurableNode = z.infer<typeof durableNodeSchema>

export const durableDetailSchema = z.object({
  info: z
    .object({
      instance_id: z.string(),
      label: z.string().nullable(),
      function_name: z.string().nullable(),
      function_version: z.string().nullable(),
      current_execution_id: z.coerce.number().nullable(),
      status: z.string().nullable(),
      output: z.string().nullable(),
    })
    .nullable(),
  nodes: z.array(durableNodeSchema),
  executions: z.array(
    z.object({
      execution_id: z.coerce.number(),
      status: z.string().nullable(),
      event_count: z.coerce.number(),
      duration_ms: z.coerce.number().nullable(),
      output: z.string().nullable(),
    })
  ),
})
export type DurableDetail = z.infer<typeof durableDetailSchema>
