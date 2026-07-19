-- Honest, repeatable configuration drift checks.
--
-- A drift check reuses the current immutable desired revision and queues an
-- observation-only operation. It never increments the desired generation and
-- never grants the Agent permission to apply direct-managed configuration.

create or replace function platform.request_configuration_drift_check(
  p_project_ref text,
  p_actor text,
  p_correlation_id text
)
returns table (
  operation_id text,
  checked_domain text,
  desired_generation bigint,
  replayed boolean
)
language plpgsql
as $$
declare
  v_binding platform.project_management_bindings%rowtype;
  v_candidate record;
  v_existing record;
  v_operation_id text;
  v_idempotency_key text;
  v_count integer := 0;
begin
  if p_project_ref = '' or p_actor = '' or p_correlation_id = '' then
    raise exception 'invalid_configuration_drift_check' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/configuration-drift-check', 0));

  select binding.* into v_binding
  from platform.project_management_bindings binding
  join platform.stack_bindings stack
    on stack.project_ref = binding.project_ref
   and stack.management_binding_id = binding.id
  where binding.project_ref = p_project_ref
    and binding.state in ('active', 'offline')
    and stack.attachment_state = 'active';
  if not found then
    raise exception 'management_target_unbound' using errcode = '55000';
  end if;

  for v_candidate in
    select policy.domain, policy.ownership_mode, policy.adapter,
           policy.policy_revision, policy.cas_token,
           desired.revision_id, desired.generation, desired.desired_document,
           desired.desired_digest
    from platform.project_ownership_policies policy
    join platform.desired_configurations desired
      on desired.project_ref = policy.project_ref
     and desired.domain = policy.domain
     and desired.capability = 'runtime.config.reconcile'
    where policy.project_ref = p_project_ref
    order by policy.domain
  loop
    v_count := v_count + 1;

    if coalesce(v_candidate.desired_document->>'ownershipMode', '') <> v_candidate.ownership_mode or
       coalesce(v_candidate.desired_document->>'adapter', '') <> v_candidate.adapter then
      raise exception 'configuration_policy_mismatch'
        using errcode = '55000',
          detail = 'the desired configuration ownership mode or adapter does not match the current policy';
    end if;

    select outbox.operation_id, outbox.desired_generation into v_existing
    from platform.operation_outbox outbox
    join platform.operation_summaries summary on summary.operation_id = outbox.operation_id
    where outbox.project_ref = p_project_ref
      and outbox.domain = v_candidate.domain
      and outbox.capability = 'runtime.config.reconcile'
      and outbox.desired_revision = v_candidate.revision_id
      and outbox.preconditions->>'observationOnly' = 'true'
      and outbox.delivery_state <> 'failed'
      and summary.state = 'queued'
    order by outbox.created_at desc
    limit 1;

    if found then
      operation_id := v_existing.operation_id;
      checked_domain := v_candidate.domain;
      desired_generation := v_existing.desired_generation;
      replayed := true;
      return next;
      continue;
    end if;

    v_operation_id := 'config_check_' || replace(gen_random_uuid()::text, '-', '');
    v_idempotency_key := 'configuration-drift-check:' || gen_random_uuid()::text;

    insert into platform.operation_outbox (
      operation_id, project_ref, target_id, binding_id, domain, capability,
      desired_revision, desired_generation, desired_digest, snapshot_canonical,
      input_schema, preconditions, idempotency_key, actor, correlation_id
    ) values (
      v_operation_id, p_project_ref, v_binding.management_target_id::text,
      v_binding.id::text, v_candidate.domain, 'runtime.config.reconcile',
      v_candidate.revision_id, v_candidate.generation, v_candidate.desired_digest,
      v_candidate.desired_document::text,
      'supabase.fleet.runtime.config.reconcile.v1',
      jsonb_build_object(
        'observationOnly', true,
        'policyRevision', v_candidate.policy_revision,
        'policyCasToken', v_candidate.cas_token
      ),
      v_idempotency_key, p_actor, p_correlation_id
    );

    insert into platform.operation_summaries (
      operation_id, project_ref, domain, capability, desired_revision,
      desired_generation, desired_digest, state
    ) values (
      v_operation_id, p_project_ref, v_candidate.domain,
      'runtime.config.reconcile', v_candidate.revision_id,
      v_candidate.generation, v_candidate.desired_digest, 'queued'
    );

    update platform.project_ownership_policies
    set drift_state = 'unknown', blockers = '[]'::jsonb, updated_at = now()
    where project_ref = p_project_ref and domain = v_candidate.domain
      and policy_revision = v_candidate.policy_revision
      and cas_token = v_candidate.cas_token;
    if not found then
      raise exception 'configuration_conflict' using errcode = '40001';
    end if;

    insert into platform.audit_events (
      actor, project_ref, action, operation_id, correlation_id, payload
    ) values (
      p_actor, p_project_ref, 'fleet.configuration.drift_check',
      v_operation_id, p_correlation_id,
      jsonb_build_object(
        'domain', v_candidate.domain,
        'desired_generation', v_candidate.generation,
        'policy_revision', v_candidate.policy_revision,
        'observation_only', true
      )
    );

    operation_id := v_operation_id;
    checked_domain := v_candidate.domain;
    desired_generation := v_candidate.generation;
    replayed := false;
    return next;
  end loop;

  if v_count = 0 then
    raise exception 'configuration_unconfigured'
      using errcode = '55000',
        detail = 'no runtime configuration desired revision exists for this project';
  end if;
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
  p_observation_only boolean,
  p_blockers jsonb,
  p_error_code text,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
as $$
declare
  v_observed boolean;
begin
  if p_project_ref = '' or p_domain = '' or p_policy_revision < 1 or
     p_observed_generation < 1 or p_observed_digest !~ '^[0-9a-f]{64}$' or
     p_operation_id = '' or p_applied and p_observation_only or
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
      and (
        not p_observation_only or
        outbox.preconditions->>'observationOnly' = 'true' or
        policy.ownership_mode in ('observe-only', 'gitops-managed')
      )
  ) then
    return false;
  end if;

  if p_applied or p_observation_only then
    select platform.apply_configuration_observation(
      p_project_ref,
      p_domain,
      p_desired_revision,
      p_observed_generation,
      p_observed_document,
      p_operation_id,
      p_observed_at
    ) into v_observed;
    if not v_observed then return false; end if;

    if p_observation_only then
      update platform.operation_summaries
      set state = 'observed',
          control_state = case when coalesce(p_error_code, '') = '' then 'succeeded' else 'failed' end,
          error_code = nullif(left(coalesce(p_error_code, ''), 128), ''),
          retryable = false,
          updated_at = now()
      where operation_id = p_operation_id
        and project_ref = p_project_ref
        and desired_revision = p_desired_revision
        and desired_generation = p_observed_generation;
    end if;
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

-- Compatibility entry point for older projectors during a rolling upgrade.
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
language sql
as $$
  select platform.apply_configuration_reconciliation_evidence(
    p_project_ref,
    p_domain,
    p_policy_revision,
    p_desired_revision,
    p_observed_generation,
    p_observed_document,
    p_observed_digest,
    p_operation_id,
    p_drift_state,
    p_applied,
    false,
    p_blockers,
    p_error_code,
    p_observed_at
  );
$$;
