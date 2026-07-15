-- T5: authoritative desired configuration, transactional outbox, immutable
-- revisions, operation summaries, and compare-and-set observations.

create table if not exists platform.desired_configurations (
  project_ref text not null references platform.projects (ref) on delete cascade,
  domain text not null,
  capability text not null,
  desired_document jsonb not null,
  desired_digest text not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  generation bigint not null check (generation > 0),
  revision_id uuid not null unique,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (project_ref, domain)
);

create table if not exists platform.configuration_revisions (
  revision_id uuid primary key,
  project_ref text not null references platform.projects (ref) on delete cascade,
  domain text not null,
  capability text not null,
  generation bigint not null check (generation > 0),
  desired_document jsonb not null,
  snapshot_canonical text not null,
  desired_digest text not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  actor text not null,
  created_at timestamptz not null default now(),
  unique (project_ref, domain, generation)
);

create table if not exists platform.operation_outbox (
  operation_id text primary key,
  project_ref text not null references platform.projects (ref) on delete cascade,
  target_id text not null,
  binding_id text not null,
  domain text not null,
  capability text not null,
  desired_revision uuid not null references platform.configuration_revisions (revision_id),
  desired_generation bigint not null check (desired_generation > 0),
  desired_digest text not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  snapshot_canonical text not null,
  input_schema text not null check (input_schema like 'supabase.fleet.%'),
  preconditions jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  actor text not null,
  correlation_id text not null,
  delivery_state text not null default 'pending'
    check (delivery_state in ('pending', 'dispatching', 'dispatched', 'retry_wait', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  last_error_message text,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_ref, idempotency_key)
);

create index if not exists operation_outbox_ready_idx
  on platform.operation_outbox (next_attempt_at, created_at)
  where delivery_state in ('pending', 'dispatching', 'retry_wait');

create table if not exists platform.operation_summaries (
  operation_id text primary key references platform.operation_outbox (operation_id) on delete restrict,
  project_ref text not null references platform.projects (ref) on delete cascade,
  domain text not null,
  capability text not null,
  desired_revision uuid not null,
  desired_generation bigint not null,
  desired_digest text not null,
  state text not null default 'queued',
  control_state text,
  error_code text,
  retryable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists operation_summaries_project_idx
  on platform.operation_summaries (project_ref, updated_at desc);

create table if not exists platform.project_observations (
  project_ref text not null references platform.projects (ref) on delete cascade,
  domain text not null,
  desired_revision uuid not null,
  observed_generation bigint not null check (observed_generation > 0),
  observed_document jsonb not null,
  observed_digest text not null check (observed_digest ~ '^[0-9a-f]{64}$'),
  operation_id text not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (project_ref, domain)
);

create table if not exists platform.audit_events (
  id bigint generated always as identity primary key,
  actor text not null,
  project_ref text not null,
  action text not null,
  operation_id text,
  correlation_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists platform_audit_project_created_idx
  on platform.audit_events (project_ref, created_at desc);

create or replace function platform.reject_immutable_configuration_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'immutable configuration records cannot be changed'
    using errcode = '55000';
end;
$$;

drop trigger if exists configuration_revisions_immutable on platform.configuration_revisions;
create trigger configuration_revisions_immutable
before update or delete on platform.configuration_revisions
for each row execute function platform.reject_immutable_configuration_change();

create or replace function platform.protect_operation_outbox_payload()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.operation_id, new.project_ref, new.target_id, new.binding_id, new.domain,
    new.capability, new.desired_revision, new.desired_generation, new.desired_digest,
    new.snapshot_canonical, new.input_schema, new.preconditions, new.idempotency_key,
    new.actor, new.correlation_id, new.created_at
  ) is distinct from row(
    old.operation_id, old.project_ref, old.target_id, old.binding_id, old.domain,
    old.capability, old.desired_revision, old.desired_generation, old.desired_digest,
    old.snapshot_canonical, old.input_schema, old.preconditions, old.idempotency_key,
    old.actor, old.correlation_id, old.created_at
  ) then
    raise exception 'operation outbox payload is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists operation_outbox_payload_immutable on platform.operation_outbox;
create trigger operation_outbox_payload_immutable
before update on platform.operation_outbox
for each row execute function platform.protect_operation_outbox_payload();

create or replace function platform.commit_desired_configuration(
  p_project_ref text,
  p_domain text,
  p_capability text,
  p_expected_generation bigint,
  p_operation_id text,
  p_target_id text,
  p_binding_id text,
  p_input_schema text,
  p_idempotency_key text,
  p_desired_document jsonb,
  p_preconditions jsonb,
  p_actor text,
  p_correlation_id text
)
returns table (
  operation_id text,
  revision_id uuid,
  generation bigint,
  desired_digest text,
  replayed boolean
)
language plpgsql
as $$
declare
  v_existing platform.operation_outbox%rowtype;
  v_revision uuid := gen_random_uuid();
  v_generation bigint;
  v_snapshot text := p_desired_document::text;
  v_digest text := encode(sha256(convert_to(p_desired_document::text, 'UTF8')), 'hex');
begin
  if p_project_ref = '' or p_domain = '' or p_capability = '' or
     p_operation_id = '' or p_target_id = '' or p_binding_id = '' or
     p_idempotency_key = '' or p_actor = '' or p_correlation_id = '' or
     p_input_schema not like 'supabase.fleet.%' then
    raise exception 'complete desired configuration identity is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/' || p_domain, 0));

  select * into v_existing
  from platform.operation_outbox
  where project_ref = p_project_ref and idempotency_key = p_idempotency_key;
  if found then
    return query select
      v_existing.operation_id,
      v_existing.desired_revision,
      v_existing.desired_generation,
      v_existing.desired_digest,
      true;
    return;
  end if;

  insert into platform.desired_configurations as desired (
    project_ref, domain, capability, desired_document, desired_digest,
    generation, revision_id, updated_by, updated_at
  ) values (
    p_project_ref, p_domain, p_capability, p_desired_document, v_digest,
    1, v_revision, p_actor, now()
  )
  on conflict (project_ref, domain) do update set
    capability = excluded.capability,
    desired_document = excluded.desired_document,
    desired_digest = excluded.desired_digest,
    generation = desired.generation + 1,
    revision_id = excluded.revision_id,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  where desired.generation = p_expected_generation
  returning desired.generation into v_generation;

  if v_generation is null or (v_generation = 1 and p_expected_generation <> 0) then
    raise exception 'configuration_conflict'
      using errcode = '40001', detail = 'expected generation does not match current generation';
  end if;

  insert into platform.configuration_revisions (
    revision_id, project_ref, domain, capability, generation, desired_document,
    snapshot_canonical, desired_digest, actor
  ) values (
    v_revision, p_project_ref, p_domain, p_capability, v_generation,
    p_desired_document, v_snapshot, v_digest, p_actor
  );

  insert into platform.operation_outbox (
    operation_id, project_ref, target_id, binding_id, domain, capability,
    desired_revision, desired_generation, desired_digest, snapshot_canonical,
    input_schema, preconditions, idempotency_key, actor, correlation_id
  ) values (
    p_operation_id, p_project_ref, p_target_id, p_binding_id, p_domain, p_capability,
    v_revision, v_generation, v_digest, v_snapshot, p_input_schema,
    coalesce(p_preconditions, '{}'::jsonb), p_idempotency_key, p_actor, p_correlation_id
  );

  insert into platform.operation_summaries (
    operation_id, project_ref, domain, capability, desired_revision,
    desired_generation, desired_digest, state
  ) values (
    p_operation_id, p_project_ref, p_domain, p_capability, v_revision,
    v_generation, v_digest, 'queued'
  );

  insert into platform.audit_events (
    actor, project_ref, action, operation_id, correlation_id, payload
  ) values (
    p_actor, p_project_ref, 'fleet.configuration.commit', p_operation_id,
    p_correlation_id,
    jsonb_build_object('domain', p_domain, 'capability', p_capability, 'generation', v_generation)
  );

  return query select p_operation_id, v_revision, v_generation, v_digest, false;
end;
$$;

create or replace function platform.apply_configuration_observation(
  p_project_ref text,
  p_domain text,
  p_desired_revision uuid,
  p_observed_generation bigint,
  p_observed_document jsonb,
  p_operation_id text,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
as $$
declare
  v_current platform.desired_configurations%rowtype;
  v_digest text := encode(sha256(convert_to(p_observed_document::text, 'UTF8')), 'hex');
  v_applied boolean;
begin
  select * into v_current
  from platform.desired_configurations
  where project_ref = p_project_ref and domain = p_domain
  for update;

  if not found or v_current.revision_id <> p_desired_revision or
     v_current.generation <> p_observed_generation then
    return false;
  end if;

  insert into platform.project_observations as observation (
    project_ref, domain, desired_revision, observed_generation,
    observed_document, observed_digest, operation_id, observed_at, updated_at
  ) values (
    p_project_ref, p_domain, p_desired_revision, p_observed_generation,
    p_observed_document, v_digest, p_operation_id, p_observed_at, now()
  )
  on conflict (project_ref, domain) do update set
    desired_revision = excluded.desired_revision,
    observed_generation = excluded.observed_generation,
    observed_document = excluded.observed_document,
    observed_digest = excluded.observed_digest,
    operation_id = excluded.operation_id,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at
  where observation.observed_generation <= excluded.observed_generation;
  v_applied := found;

  update platform.operation_summaries
  set state = 'applied', control_state = 'succeeded', updated_at = now()
  where operation_id = p_operation_id
    and project_ref = p_project_ref
    and desired_revision = p_desired_revision
    and desired_generation = p_observed_generation;

  return v_applied;
end;
$$;

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
  where candidate.next_attempt_at <= now()
    and (
      candidate.delivery_state in ('pending', 'retry_wait') or
      (candidate.delivery_state = 'dispatching' and candidate.lease_expires_at < now())
    )
  order by candidate.created_at
  for update skip locked
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
  where operation_id = p_operation_id;
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
begin
  update platform.operation_outbox
  set delivery_state = case when p_retryable then 'retry_wait' else 'failed' end,
      lease_owner = null, lease_expires_at = null,
      next_attempt_at = case when p_retryable
        then now() + make_interval(secs => least(300, greatest(1, attempts * attempts)))
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

revoke all on function platform.claim_operation_outbox(text, integer) from public;
revoke all on function platform.complete_operation_dispatch(text, text, text) from public;
revoke all on function platform.fail_operation_dispatch(text, text, text, text, boolean) from public;
