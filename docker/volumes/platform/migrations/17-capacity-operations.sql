-- T10: bound durable work before it leaves the authoritative platform store.
-- Operators may lower these settings per database. Raising them above the
-- documented tested envelope requires a new capacity test and release note.

create index if not exists operation_outbox_target_state_idx
  on platform.operation_outbox (target_id, delivery_state, created_at);

create or replace function platform.enforce_operation_outbox_capacity()
returns trigger
language plpgsql
as $$
declare
  v_organization_id bigint;
  v_organization_queued integer;
  v_target_queued integer;
  v_max_organization integer := least(100000, greatest(1,
    coalesce(nullif(current_setting('platform.fleet_max_queued_per_organization', true), '')::integer, 1000)));
  v_max_target integer := least(v_max_organization, greatest(1,
    coalesce(nullif(current_setting('platform.fleet_max_queued_per_target', true), '')::integer, 100)));
begin
  select organization_id into v_organization_id
  from platform.projects where ref = new.project_ref;
  if v_organization_id is null then
    raise exception 'project_not_found' using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fleet-capacity/org/' || v_organization_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('fleet-capacity/target/' || new.target_id, 0));

  select count(*) into v_organization_queued
  from platform.operation_outbox operation
  join platform.projects project on project.ref = operation.project_ref
  join platform.operation_summaries summary on summary.operation_id = operation.operation_id
  where project.organization_id = v_organization_id
    and (
      operation.delivery_state in ('pending', 'dispatching', 'retry_wait')
      or (operation.delivery_state = 'dispatched' and summary.state = 'queued')
    );

  select count(*) into v_target_queued
  from platform.operation_outbox operation
  join platform.operation_summaries summary on summary.operation_id = operation.operation_id
  where operation.target_id = new.target_id
    and (
      operation.delivery_state in ('pending', 'dispatching', 'retry_wait')
      or (operation.delivery_state = 'dispatched' and summary.state = 'queued')
    );

  if v_organization_queued >= v_max_organization then
    raise exception 'capacity_exceeded'
      using errcode = '54000', detail = 'organization queued operation limit reached';
  end if;
  if v_target_queued >= v_max_target then
    raise exception 'capacity_exceeded'
      using errcode = '54000', detail = 'management target queued operation limit reached';
  end if;
  return new;
end;
$$;

drop trigger if exists operation_outbox_capacity on platform.operation_outbox;
create trigger operation_outbox_capacity
before insert on platform.operation_outbox
for each row execute function platform.enforce_operation_outbox_capacity();

create or replace function platform.fail_operation_dispatch(
  p_operation_id text,
  p_worker text,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = platform, pg_temp
as $$
declare
  v_attempts integer;
  v_backoff_seconds double precision;
begin
  select attempts into v_attempts
  from platform.operation_outbox
  where operation_id = p_operation_id and lease_owner = p_worker and delivery_state = 'dispatching'
  for update;
  if not found then return false; end if;

  -- Equal jitter keeps a non-zero floor while spreading reconnect/failure
  -- storms. At-least-once delivery and the immutable idempotency key remain
  -- authoritative across process restarts.
  v_backoff_seconds := least(300.0, power(2.0, least(v_attempts, 8))) * (0.5 + random() * 0.5);

  update platform.operation_outbox
  set delivery_state = case when p_retryable then 'retry_wait' else 'failed' end,
      lease_owner = null, lease_expires_at = null,
      next_attempt_at = case when p_retryable
        then now() + make_interval(secs => v_backoff_seconds)
        else next_attempt_at end,
      last_error_code = left(p_error_code, 128),
      last_error_message = left(p_error_message, 512),
      updated_at = now()
  where operation_id = p_operation_id and lease_owner = p_worker and delivery_state = 'dispatching';
  if not found then return false; end if;

  update platform.operation_summaries
  set state = case when p_retryable then 'queued' else 'failed' end,
      error_code = left(p_error_code, 128), retryable = p_retryable, updated_at = now()
  where operation_id = p_operation_id;
  return true;
end;
$$;

revoke all on function platform.fail_operation_dispatch(text, text, text, text, boolean) from public;
