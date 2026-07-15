-- T7: organization management targets, project trust bindings, and the
-- non-secret projection of Fleet Control Agent/certificate evidence.

create table if not exists platform.management_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id bigint not null references platform.organizations (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 64),
  trust_domain text not null check (trust_domain ~ '^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$'),
  ca_reference text not null check (char_length(ca_reference) between 1 and 255),
  assertion_key_reference text not null check (assertion_key_reference ~ '^env:FLEET_MANAGEMENT_ASSERTION_[A-Z0-9_]+$'),
  state text not null default 'active' check (state in ('active', 'disabled', 'revoked')),
  created_by text not null,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (organization_id, name),
  unique (organization_id, trust_domain)
);

create table if not exists platform.management_target_domains (
  management_target_id uuid not null references platform.management_targets (id) on delete restrict,
  domain text not null check (domain in ('fleet-control', 'backup-operator')),
  api_url text not null check (api_url ~ '^https://'),
  audience text not null check (char_length(audience) between 1 and 128),
  contract_version text not null check (char_length(contract_version) between 1 and 32),
  capability_schema_prefix text not null check (capability_schema_prefix ~ '^supabase\.[a-z][a-z0-9.-]*\.$'),
  target_version text,
  state text not null default 'unverified' check (state in ('unverified', 'available', 'unavailable', 'incompatible', 'revoked')),
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (management_target_id, domain)
);

create table if not exists platform.project_management_bindings (
  id uuid primary key default gen_random_uuid(),
  project_ref text not null references platform.projects (ref) on delete restrict,
  management_target_id uuid not null references platform.management_targets (id) on delete restrict,
  execution_target text not null check (char_length(execution_target) between 1 and 255),
  deployment_kind text not null check (deployment_kind in ('compose', 'kubernetes', 'systemd', 'bare-metal')),
  allowed_capability_prefixes jsonb not null check (
    jsonb_typeof(allowed_capability_prefixes) = 'array' and jsonb_array_length(allowed_capability_prefixes) between 1 and 32
  ),
  state text not null default 'pending'
    check (state in ('pending', 'enrolling', 'active', 'offline', 'incompatible', 'revoking', 'revoked')),
  agent_id text,
  protocol_major integer,
  protocol_minor integer,
  agent_build text,
  active_certificate_revision integer check (active_certificate_revision is null or active_certificate_revision > 0),
  certificate_expires_at timestamptz,
  last_seen_at timestamptz,
  observation_revision text,
  created_by text not null,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists project_management_one_active_binding_idx
  on platform.project_management_bindings (project_ref)
  where state <> 'revoked';

alter table platform.stack_bindings
  add column if not exists management_target_id uuid references platform.management_targets (id) on delete restrict,
  add column if not exists management_binding_id uuid references platform.project_management_bindings (id) on delete restrict,
  add column if not exists execution_target text,
  add column if not exists deployment_kind text
    check (deployment_kind is null or deployment_kind in ('compose', 'kubernetes', 'systemd', 'bare-metal'));

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
)
select p.ref, capability.name, capability.state, capability.mode, 'static-profile', 'v1',
       'migration-14', now(), capability.blockers
from platform.projects p
cross join (values
  ('management.target.bind', 'available', 'direct', '[]'::jsonb),
  ('management.agent.connect', 'unavailable', 'agent',
   '[{"code":"agent_not_enrolled","message":"Issue a single-use enrollment token and enroll an Agent."}]'::jsonb),
  ('management.enrollment.issue', 'unavailable', 'operator',
   '[{"code":"management_target_unbound","message":"Bind the project to a management target before enrolling an Agent."}]'::jsonb),
  ('management.certificate.revoke', 'unavailable', 'operator',
   '[{"code":"agent_not_enrolled","message":"Enroll an Agent before revoking its certificate."}]'::jsonb)
) as capability(name, state, mode, blockers)
where p.detached_at is null
on conflict (project_ref, name) do nothing;

create or replace function platform.bind_management_target(
  p_project_ref text,
  p_management_target_id uuid,
  p_execution_target text,
  p_deployment_kind text,
  p_allowed_capability_prefixes jsonb,
  p_actor text,
  p_correlation_id text
)
returns uuid
language plpgsql
as $$
declare
  v_binding_id uuid := gen_random_uuid();
  v_project_organization_id bigint;
  v_target_organization_id bigint;
begin
  if p_project_ref = '' or p_execution_target = '' or p_actor = '' or p_correlation_id = '' or
     p_deployment_kind not in ('compose', 'kubernetes', 'systemd', 'bare-metal') or
     jsonb_typeof(p_allowed_capability_prefixes) <> 'array' or
     jsonb_array_length(p_allowed_capability_prefixes) not between 1 and 32 then
    raise exception 'invalid_management_binding' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/management-binding', 0));

  select organization_id into v_project_organization_id
  from platform.projects where ref = p_project_ref and detached_at is null;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;

  select organization_id into v_target_organization_id
  from platform.management_targets
  where id = p_management_target_id and state = 'active';
  if not found then
    raise exception 'management_target_unavailable' using errcode = '55000';
  end if;
  if v_target_organization_id <> v_project_organization_id then
    raise exception 'management_target_isolation_violation' using errcode = '42501';
  end if;
  if exists (
    select 1 from platform.project_management_bindings
    where project_ref = p_project_ref and state <> 'revoked'
  ) then
    raise exception 'management_binding_conflict' using errcode = '55000';
  end if;

  insert into platform.project_management_bindings (
    id, project_ref, management_target_id, execution_target, deployment_kind,
    allowed_capability_prefixes, state, created_by, correlation_id
  ) values (
    v_binding_id, p_project_ref, p_management_target_id, p_execution_target,
    p_deployment_kind, p_allowed_capability_prefixes, 'pending', p_actor, p_correlation_id
  );

  update platform.stack_bindings set
    management_target_id = p_management_target_id,
    management_binding_id = v_binding_id,
    execution_target = p_execution_target,
    deployment_kind = p_deployment_kind,
    management_connectivity = 'offline',
    status_observed_at = now()
  where project_ref = p_project_ref and attachment_state = 'active';
  if not found then
    raise exception 'stack_binding_inactive' using errcode = '55000';
  end if;

  insert into platform.project_capabilities (
    project_ref, name, state, mode, source, contract_version,
    observation_revision, observed_at, blockers
  ) values (
    p_project_ref, 'management.enrollment.issue', 'available', 'operator',
    'static-profile', 'v1', 'management-binding:' || v_binding_id::text,
    now(), '[]'::jsonb
  ) on conflict (project_ref, name) do update set
    state = excluded.state, mode = excluded.mode, source = excluded.source,
    contract_version = excluded.contract_version,
    observation_revision = excluded.observation_revision,
    observed_at = excluded.observed_at, valid_until = null,
    blockers = excluded.blockers;

  insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
  values (p_actor, p_project_ref, 'fleet.management_binding.create', p_correlation_id,
    jsonb_build_object('binding_id', v_binding_id, 'management_target_id', p_management_target_id,
      'execution_target', p_execution_target, 'deployment_kind', p_deployment_kind,
      'allowed_capability_prefixes', p_allowed_capability_prefixes));

  return v_binding_id;
end;
$$;

create or replace function platform.revoke_management_binding(
  p_project_ref text,
  p_binding_id uuid,
  p_actor text,
  p_correlation_id text,
  p_target_revoked boolean
)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/management-binding', 0));
  update platform.project_management_bindings set
    state = 'revoked', revoked_at = now(), updated_at = now()
  where id = p_binding_id and project_ref = p_project_ref and state <> 'revoked';
  if not found then
    raise exception 'management_binding_not_found' using errcode = 'P0002';
  end if;

  update platform.stack_bindings set
    management_connectivity = 'revoked', status_observed_at = now(),
    target_cleanup_pending = not p_target_revoked
  where project_ref = p_project_ref and management_binding_id = p_binding_id;

  update platform.project_capabilities set
    state = 'unavailable', observation_revision = 'management-binding-revoked',
    observed_at = now(), valid_until = null,
    blockers = '[{"code":"binding_revoked","message":"The management binding and Agent trust were revoked."}]'::jsonb
  where project_ref = p_project_ref and name in (
    'management.agent.connect',
    'management.enrollment.issue',
    'management.certificate.revoke'
  );

  insert into platform.project_capabilities (
    project_ref, name, state, mode, source, contract_version,
    observation_revision, observed_at, blockers
  ) values (
    p_project_ref, 'management.target.bind', 'available', 'direct',
    'static-profile', 'v1', 'management-binding-revoked', now(), '[]'::jsonb
  ) on conflict (project_ref, name) do update set
    state = excluded.state, mode = excluded.mode, source = excluded.source,
    contract_version = excluded.contract_version,
    observation_revision = excluded.observation_revision,
    observed_at = excluded.observed_at, valid_until = null,
    blockers = excluded.blockers;

  insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
  values (p_actor, p_project_ref, 'fleet.management_binding.revoke', p_correlation_id,
    jsonb_build_object('binding_id', p_binding_id, 'target_revoked', p_target_revoked));
end;
$$;

create or replace function platform.revoke_management_on_detach()
returns trigger
language plpgsql
as $$
begin
  if new.attachment_state = 'detached' and old.attachment_state <> 'detached' and new.management_binding_id is not null then
    update platform.project_management_bindings set
      state = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now()
    where id = new.management_binding_id and state <> 'revoked';
  end if;
  return new;
end;
$$;

drop trigger if exists stack_binding_revoke_management_on_detach on platform.stack_bindings;
create trigger stack_binding_revoke_management_on_detach
after update of attachment_state on platform.stack_bindings
for each row execute function platform.revoke_management_on_detach();
