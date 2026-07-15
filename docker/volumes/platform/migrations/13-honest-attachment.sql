-- T6: honest Fleet attachment, versioned connections, capability projection,
-- independent status dimensions, and non-destructive detachment.

alter table platform.projects
  alter column status set default 'COMING_UP',
  alter column jwt_secret_enc drop not null;

alter table platform.projects
  add column if not exists key_mode text not null default 'legacy-jwt'
    check (key_mode in ('legacy-jwt', 'asymmetric-jwks', 'mixed')),
  add column if not exists tls_mode text not null default 'prefer'
    check (tls_mode in ('disable', 'prefer', 'require', 'verify-ca', 'verify-full')),
  add column if not exists tls_ca_reference text,
  add column if not exists detached_at timestamptz,
  add column if not exists db_pass_readonly_enc text;

create table if not exists platform.project_connection_revisions (
  id bigint generated always as identity primary key,
  project_ref text not null references platform.projects (ref) on delete restrict,
  revision bigint not null check (revision > 0),
  state text not null check (state in ('validating', 'active', 'failed', 'rollback', 'detached')),
  key_mode text not null check (key_mode in ('legacy-jwt', 'asymmetric-jwks', 'mixed')),
  connection_document jsonb not null,
  stack_fingerprint text check (stack_fingerprint is null or stack_fingerprint ~ '^[0-9a-f]{64}$'),
  preflight_report jsonb,
  created_by text not null,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  activated_at timestamptz,
  rollback_until timestamptz,
  secrets_purge_after timestamptz,
  unique (project_ref, revision)
);

create unique index if not exists project_connection_one_active_idx
  on platform.project_connection_revisions (project_ref)
  where state = 'active';

create table if not exists platform.stack_bindings (
  project_ref text primary key references platform.projects (ref) on delete restrict,
  stack_fingerprint text check (stack_fingerprint is null or stack_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_proof_state text not null default 'unverified'
    check (fingerprint_proof_state in ('unverified', 'verified', 'revoked')),
  active_connection_revision bigint not null,
  key_mode text not null check (key_mode in ('legacy-jwt', 'asymmetric-jwks', 'mixed')),
  attachment_state text not null
    check (attachment_state in ('draft', 'validating', 'active', 'detaching', 'detached', 'failed')),
  data_plane_health text not null
    check (data_plane_health in ('unknown', 'healthy', 'degraded', 'unreachable')),
  management_connectivity text not null
    check (management_connectivity in ('unconfigured', 'online', 'offline', 'incompatible', 'revoked')),
  drift_state text not null
    check (drift_state in ('unknown', 'in-sync', 'drifted', 'ownership-conflict')),
  operation_state text not null
    check (operation_state in ('idle', 'active', 'manual-intervention')),
  first_verified_at timestamptz,
  last_verified_at timestamptz,
  status_observed_at timestamptz not null default now(),
  detached_at timestamptz,
  target_cleanup_pending boolean not null default false,
  secrets_purge_after timestamptz,
  constraint stack_binding_active_revision_fk
    foreign key (project_ref, active_connection_revision)
    references platform.project_connection_revisions (project_ref, revision)
    deferrable initially deferred
);

create unique index if not exists stack_bindings_active_fingerprint_idx
  on platform.stack_bindings (stack_fingerprint)
  where attachment_state <> 'detached' and stack_fingerprint is not null;

create table if not exists platform.project_capabilities (
  project_ref text not null references platform.projects (ref) on delete restrict,
  name text not null,
  state text not null check (state in ('available', 'unavailable', 'unauthorized', 'stale', 'unsupported')),
  mode text not null check (mode in ('direct', 'operator', 'agent', 'kubernetes-job', 'unsupported')),
  source text not null check (source in ('static-profile', 'preflight', 'service-probe', 'operator', 'agent')),
  contract_version text,
  target_version text,
  observation_revision text not null,
  observed_at timestamptz not null,
  valid_until timestamptz,
  blockers jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  primary key (project_ref, name)
);

-- Existing Fleet rows stay routable but are explicitly unverified until a
-- staged connection update proves their identity. This avoids inventing a
-- fingerprint from registry metadata.
insert into platform.project_connection_revisions (
  project_ref, revision, state, key_mode, connection_document,
  created_by, correlation_id, created_at, activated_at
)
select
  p.ref,
  1,
  'active',
  p.key_mode,
  jsonb_build_object(
    'db_host', p.db_host,
    'db_port', p.db_port,
    'db_name', p.db_name,
    'db_user', p.db_user,
    'db_user_readonly', p.db_user_readonly,
    'db_pass_enc', p.db_pass_enc,
    'db_pass_readonly_enc', p.db_pass_readonly_enc,
    'kong_url', p.kong_url,
    'rest_url', p.rest_url,
    'anon_key_enc', p.anon_key_enc,
    'service_key_enc', p.service_key_enc,
    'jwt_secret_enc', p.jwt_secret_enc,
    'publishable_key_enc', p.publishable_key_enc,
    'secret_key_enc', p.secret_key_enc,
    'tls_mode', p.tls_mode,
    'tls_ca_reference', p.tls_ca_reference
  ),
  'migration:13-honest-attachment',
  'migration:13-honest-attachment',
  p.created_at,
  p.updated_at
from platform.projects p
on conflict (project_ref, revision) do nothing;

insert into platform.stack_bindings (
  project_ref, active_connection_revision, key_mode, attachment_state,
  data_plane_health, management_connectivity, drift_state, operation_state,
  status_observed_at
)
select
  p.ref,
  1,
  p.key_mode,
  case when p.status = 'INACTIVE' then 'detached' else 'active' end,
  case
    when p.status = 'ACTIVE_HEALTHY' then 'healthy'
    when p.status = 'UNHEALTHY' then 'unreachable'
    else 'unknown'
  end,
  'unconfigured',
  'unknown',
  'idle',
  coalesce(p.updated_at, now())
from platform.projects p
on conflict (project_ref) do nothing;

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
)
select p.ref, capability.name, 'available', 'direct', 'static-profile', 'v1',
       'migration-13', now(), '[]'::jsonb
from platform.projects p
cross join (values
  ('project.status.read'),
  ('project.connection.update'),
  ('project.detach')
) as capability(name)
on conflict (project_ref, name) do nothing;

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
    and state not in ('succeeded', 'failed', 'cancelled', 'superseded');
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
    and state in ('active', 'rollback', 'failed');

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
