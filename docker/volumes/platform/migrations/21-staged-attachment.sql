-- Fleet Attach Wizard: a verified staged attachment may establish management
-- trust before it is explicitly activated. Active attachments keep the same
-- behavior; draft, failed, detaching, and detached rows remain fail-closed.

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
  where project_ref = p_project_ref and attachment_state in ('validating', 'active');
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

-- A staged attachment owns only Fleet registry/trust state, but it already
-- contains encrypted connection material. Rolling it back through the normal
-- non-destructive detach path must therefore tombstone validating revisions
-- and schedule their secret purge just like active/rollback revisions.
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
