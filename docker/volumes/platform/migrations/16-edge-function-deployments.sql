-- T9: project-scoped Edge Function artifact references and deployment pointers.
-- Artifact bytes remain authoritative in Fleet Control's independent artifact
-- store. Platform stores immutable references plus the mutable desired/active
-- deployment pointer and publishes the typed operation transactionally.

create table if not exists platform.function_artifact_references (
  project_ref text not null references platform.projects (ref) on delete restrict,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  entrypoint_path text not null,
  import_map_path text,
  static_patterns jsonb not null default '[]'::jsonb check (jsonb_typeof(static_patterns) = 'array'),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (project_ref, digest)
);

create table if not exists platform.function_deployments (
  project_ref text not null references platform.projects (ref) on delete restrict,
  slug text not null check (slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$'),
  generation bigint not null check (generation > 0),
  desired_revision uuid not null references platform.configuration_revisions (revision_id),
  desired_artifact_digest text,
  active_artifact_digest text,
  previous_artifact_digest text,
  operation_id text not null references platform.operation_outbox (operation_id) on delete restrict,
  adapter text not null check (adapter in ('compose', 'kubernetes')),
  state text not null check (state in (
    'queued', 'activating', 'probing', 'active', 'rolled-back', 'failed',
    'manual-intervention', 'deleted'
  )),
  last_error_code text,
  remediation text,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_ref, slug),
  unique (project_ref, operation_id),
  foreign key (project_ref, desired_artifact_digest)
    references platform.function_artifact_references (project_ref, digest) on delete restrict,
  foreign key (project_ref, active_artifact_digest)
    references platform.function_artifact_references (project_ref, digest) on delete restrict,
  foreign key (project_ref, previous_artifact_digest)
    references platform.function_artifact_references (project_ref, digest) on delete restrict
);

create index if not exists function_deployments_project_updated_idx
  on platform.function_deployments (project_ref, updated_at desc);

drop trigger if exists function_artifact_references_immutable on platform.function_artifact_references;
create trigger function_artifact_references_immutable
before update or delete on platform.function_artifact_references
for each row execute function platform.reject_immutable_configuration_change();

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
)
select p.ref, capability.name, capability.state, capability.mode,
       capability.source, 'v1', 'migration-16', now(), capability.blockers
from platform.projects p
cross join (values
  ('functions.read', 'available', 'direct', 'static-profile', '[]'::jsonb),
  ('functions.deploy', 'unavailable', 'agent', 'agent',
   '[{"code":"agent_capability_unavailable","message":"Connect an Agent with the functions.deploy v1 capability."}]'::jsonb)
) as capability(name, state, mode, source, blockers)
where p.detached_at is null
on conflict (project_ref, name) do nothing;

insert into platform.project_ownership_policies (
  project_ref, domain, ownership_mode, adapter, updated_by
)
select binding.project_ref, 'functions', 'observe-only', binding.deployment_kind,
       'migration:16-edge-function-deployments'
from platform.project_management_bindings binding
where binding.state <> 'revoked' and binding.deployment_kind in ('compose', 'kubernetes')
on conflict (project_ref, domain) do nothing;

create or replace function platform.seed_function_ownership_policy()
returns trigger
language plpgsql
as $$
begin
  if new.deployment_kind in ('compose', 'kubernetes') then
    insert into platform.project_ownership_policies (
      project_ref, domain, ownership_mode, adapter, updated_by
    ) values (
      new.project_ref, 'functions', 'observe-only', new.deployment_kind,
      'function-ownership-binding:' || new.id::text
    ) on conflict (project_ref, domain) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists seed_function_ownership_policy on platform.project_management_bindings;
create trigger seed_function_ownership_policy
after insert on platform.project_management_bindings
for each row execute function platform.seed_function_ownership_policy();

create or replace function platform.commit_function_deployment(
  p_project_ref text,
  p_slug text,
  p_action text,
  p_artifact_digest text,
  p_artifact_size bigint,
  p_entrypoint_path text,
  p_import_map_path text,
  p_static_patterns jsonb,
  p_verify_jwt boolean,
  p_expected_generation bigint,
  p_operation_id text,
  p_idempotency_key text,
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
  v_binding platform.project_management_bindings%rowtype;
  v_domain text;
  v_document jsonb;
  v_committed record;
begin
  if p_project_ref = '' or p_slug !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$' or
     p_action not in ('deploy', 'delete') or p_expected_generation < 0 or
     p_operation_id = '' or p_idempotency_key = '' or p_actor = '' or p_correlation_id = '' or
     jsonb_typeof(coalesce(p_static_patterns, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_function_deployment' using errcode = '22023';
  end if;

  select * into v_binding
  from platform.project_management_bindings
  where project_ref = p_project_ref and state = 'active';
  if not found or v_binding.deployment_kind not in ('compose', 'kubernetes') or not exists (
    select 1 from platform.management_targets
    where id = v_binding.management_target_id and state = 'active'
  ) then
    raise exception 'management_target_unbound' using errcode = '55000';
  end if;
  if not exists (
    select 1 from platform.project_capabilities
    where project_ref = p_project_ref and name = 'functions.deploy'
      and state = 'available' and mode = 'agent'
      and (valid_until is null or valid_until >= now())
  ) then
    raise exception 'capability_unavailable' using errcode = '55000';
  end if;
  if not exists (
    select 1 from platform.project_ownership_policies
    where project_ref = p_project_ref and domain = 'functions'
      and ownership_mode = 'direct-managed' and adapter = v_binding.deployment_kind
  ) then
    raise exception 'ownership_conflict'
      using errcode = '55000', detail = 'functions ownership policy must be direct-managed';
  end if;

  if p_action = 'deploy' then
    if p_artifact_digest !~ '^[0-9a-f]{64}$' or p_artifact_size < 1 or
       p_artifact_size > 20971520 or p_entrypoint_path = '' then
      raise exception 'invalid_function_artifact' using errcode = '22023';
    end if;
    insert into platform.function_artifact_references (
      project_ref, digest, size_bytes, entrypoint_path, import_map_path,
      static_patterns, created_by
    ) values (
      p_project_ref, p_artifact_digest, p_artifact_size, p_entrypoint_path,
      nullif(p_import_map_path, ''), coalesce(p_static_patterns, '[]'::jsonb), p_actor
    ) on conflict (project_ref, digest) do nothing;
    if not exists (
      select 1 from platform.function_artifact_references
      where project_ref = p_project_ref and digest = p_artifact_digest
        and size_bytes = p_artifact_size and entrypoint_path = p_entrypoint_path
        and coalesce(import_map_path, '') = coalesce(p_import_map_path, '')
        and static_patterns = coalesce(p_static_patterns, '[]'::jsonb)
    ) then
      raise exception 'artifact_conflict' using errcode = '55000';
    end if;
  elsif p_artifact_digest <> '' or p_artifact_size <> 0 or p_entrypoint_path <> '' or
        p_import_map_path <> '' or coalesce(p_static_patterns, '[]'::jsonb) <> '[]'::jsonb then
    raise exception 'delete_artifact_conflict' using errcode = '22023';
  end if;

  v_domain := 'functions-' || left(p_slug, 39) || '-' ||
    left(encode(sha256(convert_to(p_slug, 'UTF8')), 'hex'), 12);
  v_document := jsonb_build_object(
    'action', p_action,
    'slug', p_slug,
    'adapter', v_binding.deployment_kind,
    'staticPatterns', coalesce(p_static_patterns, '[]'::jsonb),
    'verifyJwt', p_verify_jwt
  );
  if p_action = 'deploy' then
    v_document := v_document || jsonb_build_object(
      'artifactDigest', p_artifact_digest,
      'artifactSize', p_artifact_size,
      'entrypointPath', p_entrypoint_path
    );
    if p_import_map_path <> '' then
      v_document := v_document || jsonb_build_object('importMapPath', p_import_map_path);
    end if;
  end if;

  select * into v_committed from platform.commit_desired_configuration(
    p_project_ref, v_domain, 'functions.deploy', p_expected_generation,
    p_operation_id, v_binding.management_target_id::text, v_binding.id::text,
    'supabase.fleet.functions.deploy.v1', p_idempotency_key, v_document,
    jsonb_build_object('artifactDigest', nullif(p_artifact_digest, '')),
    p_actor, p_correlation_id
  );

  if v_committed.replayed and not exists (
    select 1 from platform.operation_outbox operation
    where operation.project_ref = p_project_ref
      and operation.operation_id = v_committed.operation_id
      and operation.domain = v_domain
      and operation.capability = 'functions.deploy'
      and operation.input_schema = 'supabase.fleet.functions.deploy.v1'
      and operation.snapshot_canonical = v_document::text
  ) then
    raise exception 'idempotency_conflict'
      using errcode = '55000', detail = 'idempotency key belongs to another function deployment input';
  end if;

  if not v_committed.replayed then
    insert into platform.function_deployments as deployment (
      project_ref, slug, generation, desired_revision, desired_artifact_digest,
      active_artifact_digest, previous_artifact_digest, operation_id, adapter,
      state, last_error_code, remediation, updated_at
    ) values (
      p_project_ref, p_slug, v_committed.generation, v_committed.revision_id,
      nullif(p_artifact_digest, ''),
      (select active_artifact_digest from platform.function_deployments where project_ref = p_project_ref and slug = p_slug),
      (select active_artifact_digest from platform.function_deployments where project_ref = p_project_ref and slug = p_slug),
      p_operation_id, v_binding.deployment_kind, 'queued', null, null, now()
    ) on conflict (project_ref, slug) do update set
      generation = excluded.generation,
      desired_revision = excluded.desired_revision,
      desired_artifact_digest = excluded.desired_artifact_digest,
      previous_artifact_digest = deployment.active_artifact_digest,
      operation_id = excluded.operation_id,
      adapter = excluded.adapter,
      state = 'queued', last_error_code = null, remediation = null,
      updated_at = now();

    insert into platform.audit_events (actor, project_ref, action, operation_id, correlation_id, payload)
    values (p_actor, p_project_ref, 'fleet.function.' || p_action, p_operation_id,
      p_correlation_id, jsonb_build_object('slug', p_slug, 'artifact_digest', nullif(p_artifact_digest, ''),
        'generation', v_committed.generation, 'adapter', v_binding.deployment_kind));
  end if;

  return query select v_committed.operation_id, v_committed.revision_id,
    v_committed.generation, v_committed.desired_digest, v_committed.replayed;
end;
$$;

create or replace function platform.apply_function_deployment_observation(
  p_project_ref text,
  p_slug text,
  p_operation_id text,
  p_desired_revision uuid,
  p_observed_generation bigint,
  p_status text,
  p_artifact_digest text,
  p_previous_digest text,
  p_error_code text,
  p_remediation text,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = platform, pg_temp
as $$
begin
  if p_status not in ('active', 'rolled-back', 'manual-intervention', 'deleted') then
    raise exception 'invalid_function_observation' using errcode = '22023';
  end if;
  update platform.function_deployments set
    state = p_status,
    active_artifact_digest = case
      when p_status = 'manual-intervention' then active_artifact_digest
      else nullif(p_artifact_digest, '')
    end,
    previous_artifact_digest = nullif(p_previous_digest, ''),
    last_error_code = nullif(p_error_code, ''),
    remediation = nullif(p_remediation, ''),
    observed_at = p_observed_at,
    updated_at = now()
  where project_ref = p_project_ref and slug = p_slug
    and operation_id = p_operation_id and desired_revision = p_desired_revision
    and generation = p_observed_generation
    and p_observed_at is not null
    and nullif(p_previous_digest, '') is not distinct from previous_artifact_digest
    and (
      (p_status = 'active' and nullif(p_artifact_digest, '') = desired_artifact_digest) or
      (p_status = 'deleted' and p_artifact_digest = '' and desired_artifact_digest is null) or
      (p_status = 'rolled-back' and nullif(p_artifact_digest, '') is not distinct from previous_artifact_digest) or
      (p_status = 'manual-intervention' and (
        nullif(p_artifact_digest, '') is not distinct from desired_artifact_digest or
        nullif(p_artifact_digest, '') is not distinct from previous_artifact_digest
      ))
    );
  if not found then return false; end if;

  update platform.operation_summaries set
    state = case
      when p_status in ('active', 'deleted') then 'applied'
      when p_status = 'manual-intervention' then 'manual_intervention'
      else 'failed'
    end,
    control_state = case when p_status in ('active', 'deleted') then 'succeeded' else p_status end,
    error_code = nullif(p_error_code, ''), retryable = false, updated_at = now()
  where project_ref = p_project_ref and operation_id = p_operation_id
    and desired_revision = p_desired_revision and desired_generation = p_observed_generation;
  return true;
end;
$$;

revoke all on function platform.apply_function_deployment_observation(
  text, text, text, uuid, bigint, text, text, text, text, text, timestamptz
) from public;

-- Rollback/forward repair: stop new functions.deploy commits first. Deployment
-- rows and artifact references are retained for audit. Re-point a deployment to
-- a retained digest with a new CAS generation; never mutate or replace a digest.
