-- Fleet desired-state ownership repair and contract enrichment.
--
-- Migration 15 seeded capabilities and policies only for projects and bindings
-- that existed while that migration ran. Staged attachments created later
-- therefore had no configuration.ownership.* capability. This migration
-- repairs existing rows and makes ownership state part of every future binding.

alter table platform.project_ownership_policies
  add column if not exists field_owners jsonb not null default '{}'::jsonb,
  add column if not exists cas_token uuid not null default gen_random_uuid();

alter table platform.project_ownership_policies
  drop constraint if exists project_ownership_policies_field_owners_check;
alter table platform.project_ownership_policies
  add constraint project_ownership_policies_field_owners_check check (
    jsonb_typeof(field_owners) = 'object' and
    not jsonb_path_exists(
      field_owners,
      '$.keyvalue() ? (@.value != "fleet" && @.value != "project-service" && @.value != "user")'
    )
  );

update platform.project_ownership_policies
set field_owners = jsonb_build_object(
  '*',
  case ownership_mode
    when 'direct-managed' then 'fleet'
    when 'gitops-managed' then 'project-service'
    else 'user'
  end
)
where field_owners = '{}'::jsonb;

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
)
select project.ref, capability.name, 'available', 'direct', 'static-profile', 'v1',
       'migration-24', now(), '[]'::jsonb
from platform.projects project
join platform.stack_bindings stack on stack.project_ref = project.ref
cross join (values
  ('configuration.ownership.read'),
  ('configuration.ownership.update')
) as capability(name)
where project.detached_at is null
  and stack.attachment_state in ('validating', 'active')
on conflict (project_ref, name) do update set
  state = excluded.state,
  mode = excluded.mode,
  source = excluded.source,
  contract_version = excluded.contract_version,
  observation_revision = excluded.observation_revision,
  observed_at = excluded.observed_at,
  valid_until = null,
  blockers = excluded.blockers;

insert into platform.project_ownership_policies (
  project_ref, domain, ownership_mode, adapter, field_owners, updated_by
)
select binding.project_ref, domain.name, 'observe-only', binding.deployment_kind,
       '{"*":"user"}'::jsonb, 'migration:24-configuration-ownership-state'
from platform.project_management_bindings binding
join platform.stack_bindings stack
  on stack.project_ref = binding.project_ref
 and stack.management_binding_id = binding.id
cross join (values ('auth'), ('storage'), ('realtime'), ('postgrest'), ('functions')) as domain(name)
where binding.state <> 'revoked'
  and binding.deployment_kind in ('compose', 'kubernetes', 'systemd', 'bare-metal')
  and stack.attachment_state in ('validating', 'active')
on conflict (project_ref, domain) do nothing;

create or replace function platform.seed_configuration_ownership()
returns trigger
language plpgsql
as $$
begin
  insert into platform.project_capabilities (
    project_ref, name, state, mode, source, contract_version,
    observation_revision, observed_at, blockers
  ) values
    (new.project_ref, 'configuration.ownership.read', 'available', 'direct',
     'static-profile', 'v1', 'management-binding:' || new.id::text, now(), '[]'::jsonb),
    (new.project_ref, 'configuration.ownership.update', 'available', 'direct',
     'static-profile', 'v1', 'management-binding:' || new.id::text, now(), '[]'::jsonb)
  on conflict (project_ref, name) do update set
    state = excluded.state,
    mode = excluded.mode,
    source = excluded.source,
    contract_version = excluded.contract_version,
    observation_revision = excluded.observation_revision,
    observed_at = excluded.observed_at,
    valid_until = null,
    blockers = excluded.blockers;

  insert into platform.project_ownership_policies (
    project_ref, domain, ownership_mode, adapter, field_owners, updated_by
  )
  select new.project_ref, domain.name, 'observe-only', new.deployment_kind,
         '{"*":"user"}'::jsonb, 'management-binding:' || new.id::text
  from (values ('auth'), ('storage'), ('realtime'), ('postgrest'), ('functions')) as domain(name)
  on conflict (project_ref, domain) do nothing;

  return new;
end;
$$;

drop trigger if exists seed_configuration_ownership on platform.project_management_bindings;
create trigger seed_configuration_ownership
after insert on platform.project_management_bindings
for each row execute function platform.seed_configuration_ownership();

create or replace function platform.set_project_ownership_policy(
  p_project_ref text,
  p_domain text,
  p_ownership_mode text,
  p_expected_revision bigint,
  p_actor text,
  p_correlation_id text,
  p_field_owners jsonb,
  p_expected_cas_token uuid
)
returns platform.project_ownership_policies
language plpgsql
as $$
declare
  v_adapter text;
  v_exists boolean;
  v_policy platform.project_ownership_policies%rowtype;
  v_field_owners jsonb := coalesce(
    p_field_owners,
    jsonb_build_object(
      '*',
      case p_ownership_mode
        when 'direct-managed' then 'fleet'
        when 'gitops-managed' then 'project-service'
        else 'user'
      end
    )
  );
begin
  if p_project_ref = '' or p_domain !~ '^[a-z][a-z0-9-]{0,63}$' or
     p_ownership_mode not in ('observe-only', 'direct-managed', 'gitops-managed') or
     p_expected_revision < 0 or p_actor = '' or p_correlation_id = '' or
     jsonb_typeof(v_field_owners) <> 'object' or
     jsonb_path_exists(
       v_field_owners,
       '$.keyvalue() ? (@.value != "fleet" && @.value != "project-service" && @.value != "user")'
     ) then
    raise exception 'invalid_ownership_policy' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/ownership/' || p_domain, 0));

  select binding.deployment_kind into v_adapter
  from platform.project_management_bindings binding
  join platform.stack_bindings stack
    on stack.project_ref = binding.project_ref
   and stack.management_binding_id = binding.id
  where binding.project_ref = p_project_ref
    and binding.state in ('pending', 'enrolling', 'active', 'offline', 'incompatible')
    and stack.attachment_state = 'active';
  if not found then
    raise exception 'management_target_unbound' using errcode = '55000';
  end if;
  if p_ownership_mode = 'direct-managed' and v_adapter not in ('compose', 'kubernetes') then
    raise exception 'capability_unavailable'
      using errcode = '55000', detail = 'direct-managed provider supports Compose and Kubernetes bindings';
  end if;

  select * into v_policy
  from platform.project_ownership_policies
  where project_ref = p_project_ref and domain = p_domain;
  v_exists := found;

  if v_exists then
    if v_policy.policy_revision <> p_expected_revision or
       (p_expected_cas_token is not null and v_policy.cas_token <> p_expected_cas_token) then
      raise exception 'configuration_conflict'
        using errcode = '40001', detail = 'expected ownership policy revision or CAS token does not match';
    end if;
    update platform.project_ownership_policies set
      ownership_mode = p_ownership_mode,
      adapter = v_adapter,
      field_owners = v_field_owners,
      policy_revision = policy_revision + 1,
      cas_token = gen_random_uuid(),
      drift_state = 'unknown',
      blockers = '[]'::jsonb,
      last_operation_id = null,
      last_observed_generation = null,
      last_observed_digest = null,
      last_observed_at = null,
      updated_by = p_actor,
      updated_at = now()
    where project_ref = p_project_ref and domain = p_domain
    returning * into v_policy;
  else
    if p_expected_revision <> 0 or p_expected_cas_token is not null then
      raise exception 'configuration_conflict'
        using errcode = '40001', detail = 'expected ownership policy revision or CAS token does not match';
    end if;
    insert into platform.project_ownership_policies (
      project_ref, domain, ownership_mode, adapter, field_owners,
      policy_revision, drift_state, blockers, updated_by, updated_at
    ) values (
      p_project_ref, p_domain, p_ownership_mode, v_adapter, v_field_owners,
      1, 'unknown', '[]'::jsonb, p_actor, now()
    ) returning * into v_policy;
  end if;

  update platform.stack_bindings set
    drift_state = 'unknown', status_observed_at = now()
  where project_ref = p_project_ref and attachment_state = 'active';

  insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
  values (p_actor, p_project_ref, 'fleet.ownership_policy.update', p_correlation_id,
    jsonb_build_object(
      'domain', p_domain,
      'ownership_mode', p_ownership_mode,
      'adapter', v_adapter,
      'field_owners', v_field_owners,
      'policy_revision', v_policy.policy_revision,
      'cas_token', v_policy.cas_token
    ));

  return v_policy;
end;
$$;

create or replace function platform.apply_configuration_reconciliation_evidence(
  p_project_ref text,
  p_domain text,
  p_policy_revision bigint,
  p_desired_revision uuid,
  p_observed_generation bigint,
  p_observed_document jsonb,
  p_observed_digest text,
  p_operation_id text,
  p_drift_state text,
  p_applied boolean,
  p_blockers jsonb,
  p_error_code text,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
as $$
declare
  v_applied boolean;
begin
  if p_project_ref = '' or p_domain = '' or p_policy_revision < 1 or
     p_observed_generation < 1 or p_observed_digest !~ '^[0-9a-f]{64}$' or
     p_operation_id = '' or
     p_drift_state not in ('in-sync', 'drifted', 'ownership-conflict') or
     jsonb_typeof(p_blockers) <> 'array' then
    raise exception 'invalid_configuration_evidence' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/ownership/' || p_domain, 0));

  if not exists (
    select 1
    from platform.operation_outbox outbox
    join platform.project_ownership_policies policy
      on policy.project_ref = outbox.project_ref and policy.domain = outbox.domain
    where outbox.operation_id = p_operation_id
      and outbox.project_ref = p_project_ref
      and outbox.domain = p_domain
      and outbox.desired_revision = p_desired_revision
      and outbox.desired_generation = p_observed_generation
      and outbox.capability = 'runtime.config.reconcile'
      and policy.policy_revision = p_policy_revision
  ) then
    return false;
  end if;

  if p_applied then
    select platform.apply_configuration_observation(
      p_project_ref,
      p_domain,
      p_desired_revision,
      p_observed_generation,
      p_observed_document,
      p_operation_id,
      p_observed_at
    ) into v_applied;
    if not v_applied then return false; end if;
  else
    update platform.operation_summaries set
      state = 'failed',
      control_state = 'failed',
      error_code = left(coalesce(nullif(p_error_code, ''), 'configuration_not_applied'), 128),
      retryable = false,
      updated_at = now()
    where operation_id = p_operation_id
      and project_ref = p_project_ref
      and desired_revision = p_desired_revision
      and desired_generation = p_observed_generation
      and state = 'queued';
    if not found then return false; end if;
  end if;

  if not platform.apply_ownership_observation(
    p_project_ref,
    p_domain,
    p_policy_revision,
    p_operation_id,
    p_observed_generation,
    p_observed_digest,
    p_drift_state,
    p_blockers,
    p_observed_at
  ) then
    raise exception 'stale_ownership_evidence' using errcode = '40001';
  end if;

  return true;
end;
$$;

create or replace function platform.apply_configuration_operation_failure(
  p_project_ref text,
  p_operation_id text,
  p_desired_revision uuid,
  p_desired_generation bigint,
  p_error_code text
)
returns boolean
language plpgsql
as $$
begin
  update platform.operation_summaries set
    state = 'failed',
    control_state = 'failed',
    error_code = left(coalesce(nullif(p_error_code, ''), 'provider_failed'), 128),
    retryable = false,
    updated_at = now()
  where operation_id = p_operation_id
    and project_ref = p_project_ref
    and desired_revision = p_desired_revision
    and desired_generation = p_desired_generation
    and state = 'queued';
  return found;
end;
$$;

-- Backward-compatible server-side entry point. Existing acceptance scripts and
-- callers still receive revision CAS, while the HTTP contract supplies both
-- revision and the stronger opaque token.
create or replace function platform.set_project_ownership_policy(
  p_project_ref text,
  p_domain text,
  p_ownership_mode text,
  p_expected_revision bigint,
  p_actor text,
  p_correlation_id text
)
returns platform.project_ownership_policies
language sql
as $$
  select platform.set_project_ownership_policy(
    p_project_ref,
    p_domain,
    p_ownership_mode,
    p_expected_revision,
    p_actor,
    p_correlation_id,
    null,
    null
  );
$$;
