-- Keep detach safety aligned with the authoritative platform operation states.
-- A newer desired generation supersedes an older queued summary for the same
-- domain. Dispatch and projection history remain immutable for audit.

create or replace function platform.supersede_prior_operation_summaries()
returns trigger
language plpgsql
as $$
begin
  update platform.operation_summaries summary
  set state = 'superseded',
      control_state = 'superseded',
      retryable = false,
      updated_at = now()
  where summary.project_ref = new.project_ref
    and summary.domain = new.domain
    and summary.capability = new.capability
    and summary.desired_generation < new.desired_generation
    and summary.state = 'queued';
  return new;
end;
$$;

drop trigger if exists supersede_prior_operation_summaries
  on platform.operation_summaries;
create trigger supersede_prior_operation_summaries
before insert on platform.operation_summaries
for each row execute function platform.supersede_prior_operation_summaries();

-- Repair rows created before the trigger existed. These rows can no longer be
-- projected after the mutable desired pointer advances to a newer generation.
update platform.operation_summaries summary
set state = 'superseded',
    control_state = 'superseded',
    retryable = false,
    updated_at = now()
where summary.state = 'queued'
  and exists (
    select 1
    from platform.operation_summaries newer
    where newer.project_ref = summary.project_ref
      and newer.domain = summary.domain
      and newer.capability = summary.capability
      and newer.desired_generation > summary.desired_generation
  );

create or replace function platform.claim_operation_outbox(
  p_worker text,
  p_lease_seconds integer default 30
)
returns setof platform.operation_outbox
language plpgsql
security definer
set search_path = platform, pg_temp
as $$
declare
  v_operation_id text;
begin
  if p_worker = '' or p_lease_seconds < 5 or p_lease_seconds > 300 then
    raise exception 'invalid outbox lease request' using errcode = '22023';
  end if;
  select candidate.operation_id into v_operation_id
  from platform.operation_outbox candidate
  join platform.operation_summaries summary
    on summary.operation_id = candidate.operation_id
   and summary.state = 'queued'
  where candidate.next_attempt_at <= now()
    and (
      candidate.delivery_state in ('pending', 'retry_wait') or
      (candidate.delivery_state = 'dispatching' and candidate.lease_expires_at < now())
    )
  order by candidate.created_at
  for update of candidate skip locked
  limit 1;
  if v_operation_id is null then return; end if;
  return query
  update platform.operation_outbox
  set delivery_state = 'dispatching', attempts = attempts + 1,
      lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where operation_outbox.operation_id = v_operation_id
  returning operation_outbox.*;
end;
$$;

create or replace function platform.complete_operation_dispatch(
  p_operation_id text,
  p_worker text,
  p_control_state text
)
returns boolean
language plpgsql
security definer
set search_path = platform, pg_temp
as $$
begin
  update platform.operation_outbox
  set delivery_state = 'dispatched', lease_owner = null, lease_expires_at = null,
      dispatched_at = coalesce(dispatched_at, now()), updated_at = now(),
      last_error_code = null, last_error_message = null
  where operation_id = p_operation_id and lease_owner = p_worker and delivery_state = 'dispatching';
  if not found then return false; end if;
  update platform.operation_summaries
  set state = 'queued', control_state = p_control_state, updated_at = now()
  where operation_id = p_operation_id and state = 'queued';
  return true;
end;
$$;

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
  where operation_id = p_operation_id and state = 'queued';
  return true;
end;
$$;

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
    and summary.state = 'queued'
    and operation.delivery_state in ('pending', 'dispatching', 'retry_wait', 'dispatched');

  select count(*) into v_target_queued
  from platform.operation_outbox operation
  join platform.operation_summaries summary on summary.operation_id = operation.operation_id
  where operation.target_id = new.target_id
    and summary.state = 'queued'
    and operation.delivery_state in ('pending', 'dispatching', 'retry_wait', 'dispatched');

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

create or replace function platform.detach_project(
  p_project_ref text,
  p_actor text,
  p_correlation_id text,
  p_secret_retention interval default interval '7 days'
)
returns table (
  project_ref text,
  detached_at timestamptz,
  target_cleanup_pending boolean,
  infrastructure_deleted boolean
)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_management_connectivity text;
  v_operation_count integer;
  v_cleanup_pending boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/detach', 0));

  select count(*)::integer into v_operation_count
  from platform.operation_summaries
  where operation_summaries.project_ref = p_project_ref
    and state not in (
      'applied', 'observed', 'failed', 'manual_intervention',
      'succeeded', 'cancelled', 'superseded', 'timed_out'
    );
  if v_operation_count > 0 then
    raise exception 'operation_conflict'
      using errcode = '55000', detail = 'active operations must finish before detach';
  end if;

  select management_connectivity into v_management_connectivity
  from platform.stack_bindings
  where stack_bindings.project_ref = p_project_ref
    and attachment_state <> 'detached'
  for update;
  if not found then
    raise exception 'binding_revoked' using errcode = '55000';
  end if;

  v_cleanup_pending := v_management_connectivity not in ('unconfigured', 'revoked');

  update platform.stack_bindings set
    attachment_state = 'detached',
    fingerprint_proof_state = 'revoked',
    management_connectivity = case
      when v_management_connectivity = 'unconfigured' then 'unconfigured'
      else 'revoked'
    end,
    detached_at = v_now,
    status_observed_at = v_now,
    target_cleanup_pending = v_cleanup_pending,
    secrets_purge_after = v_now + p_secret_retention
  where stack_bindings.project_ref = p_project_ref;

  update platform.project_connection_revisions set
    state = 'detached',
    secrets_purge_after = v_now + p_secret_retention
  where project_connection_revisions.project_ref = p_project_ref
    and state in ('validating', 'active', 'rollback', 'failed');

  update platform.project_capabilities set
    state = 'unavailable',
    observation_revision = 'detached',
    observed_at = v_now,
    valid_until = null,
    blockers = '[{"code":"binding_revoked","message":"The stack is detached from Fleet Studio."}]'::jsonb
  where project_capabilities.project_ref = p_project_ref;

  update platform.projects set
    status = 'INACTIVE',
    detached_at = v_now,
    updated_at = v_now
  where ref = p_project_ref;

  insert into platform.audit_events (
    actor, project_ref, action, correlation_id, payload
  ) values (
    p_actor,
    p_project_ref,
    'fleet.project.detach',
    p_correlation_id,
    jsonb_build_object(
      'target_cleanup_pending', v_cleanup_pending,
      'infrastructure_deleted', false,
      'secret_retention_until', v_now + p_secret_retention
    )
  );

  return query select p_project_ref, v_now, v_cleanup_pending, false;
end;
$$;

revoke all on function platform.supersede_prior_operation_summaries() from public;
revoke all on function platform.claim_operation_outbox(text, integer) from public;
revoke all on function platform.complete_operation_dispatch(text, text, text) from public;
revoke all on function platform.fail_operation_dispatch(text, text, text, text, boolean) from public;
revoke all on function platform.detach_project(text, text, text, interval) from public;
