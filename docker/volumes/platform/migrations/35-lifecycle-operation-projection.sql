-- Lifecycle operations carry no configuration evidence, so no projection moved
-- their summaries out of `queued`. The dispatcher now projects Fleet Control's
-- terminal state, keeping operation lists accurate.
create or replace function platform.next_lifecycle_projection()
returns table (
  operation_id text,
  project_ref text,
  desired_revision uuid,
  desired_generation bigint
)
language sql
security definer
set search_path = platform, pg_temp
as $$
  select outbox.operation_id,
         outbox.project_ref,
         outbox.desired_revision,
         outbox.desired_generation
  from platform.operation_outbox outbox
  join platform.operation_summaries summary on summary.operation_id = outbox.operation_id
  where outbox.input_schema = 'supabase.fleet.lifecycle.execute.v1'
    and outbox.delivery_state = 'dispatched'
    and summary.state = 'queued'
  order by summary.updated_at
  limit 1;
$$;

revoke all on function platform.next_lifecycle_projection() from public;

create or replace function platform.apply_lifecycle_operation_result(
  p_project_ref text,
  p_operation_id text,
  p_desired_revision uuid,
  p_desired_generation bigint,
  p_control_state text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = platform, pg_temp
as $$
begin
  if p_control_state not in ('succeeded', 'failed', 'cancelled', 'timed_out') then
    return false;
  end if;

  update platform.operation_summaries summary set
    state = case p_control_state
      when 'succeeded' then 'applied'
      when 'cancelled' then 'cancelled'
      else 'failed'
    end,
    control_state = p_control_state,
    error_code = case
      when p_control_state = 'succeeded' then null
      else left(coalesce(nullif(p_error_code, ''), p_control_state), 128)
    end,
    retryable = false,
    updated_at = now()
  from platform.operation_outbox outbox
  where summary.operation_id = p_operation_id
    and summary.project_ref = p_project_ref
    and summary.desired_revision = p_desired_revision
    and summary.desired_generation = p_desired_generation
    and summary.state = 'queued'
    and outbox.operation_id = summary.operation_id
    and outbox.input_schema = 'supabase.fleet.lifecycle.execute.v1';
  return found;
end;
$$;

revoke all on function platform.apply_lifecycle_operation_result(text, text, uuid, bigint, text, text) from public;
