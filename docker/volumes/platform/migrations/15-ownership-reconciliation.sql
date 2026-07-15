-- T8: platform-authoritative per-domain ownership policy and redacted drift
-- projection. Runtime desired documents remain owned by migration 12; this
-- migration controls whether an Agent may observe, reconcile Fleet-owned
-- fields, or export changes for an external GitOps source of truth.

create table if not exists platform.project_ownership_policies (
  project_ref text not null references platform.projects (ref) on delete restrict,
  domain text not null check (domain ~ '^[a-z][a-z0-9-]{0,63}$'),
  ownership_mode text not null
    check (ownership_mode in ('observe-only', 'direct-managed', 'gitops-managed')),
  adapter text not null
    check (adapter in ('compose', 'kubernetes', 'systemd', 'bare-metal')),
  policy_revision bigint not null default 1 check (policy_revision > 0),
  drift_state text not null default 'unknown'
    check (drift_state in ('unknown', 'in-sync', 'drifted', 'ownership-conflict')),
  blockers jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  last_operation_id text,
  last_observed_generation bigint check (last_observed_generation is null or last_observed_generation > 0),
  last_observed_digest text check (last_observed_digest is null or last_observed_digest ~ '^[0-9a-f]{64}$'),
  last_observed_at timestamptz,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_ref, domain)
);

insert into platform.project_ownership_policies (
  project_ref, domain, ownership_mode, adapter, updated_by
)
select binding.project_ref, domain.name, 'observe-only', binding.deployment_kind,
       'migration:15-ownership-reconciliation'
from platform.project_management_bindings binding
cross join (values ('auth'), ('storage'), ('realtime'), ('postgrest')) as domain(name)
where binding.state <> 'revoked'
on conflict (project_ref, domain) do nothing;

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
)
select p.ref, capability.name, 'available', 'direct', 'static-profile', 'v1',
       'migration-15', now(), '[]'::jsonb
from platform.projects p
cross join (values
  ('configuration.ownership.read'),
  ('configuration.ownership.update')
) as capability(name)
where p.detached_at is null
on conflict (project_ref, name) do update set
  state = excluded.state,
  mode = excluded.mode,
  source = excluded.source,
  contract_version = excluded.contract_version,
  observation_revision = excluded.observation_revision,
  observed_at = excluded.observed_at,
  valid_until = null,
  blockers = excluded.blockers;

create or replace function platform.set_project_ownership_policy(
  p_project_ref text,
  p_domain text,
  p_ownership_mode text,
  p_expected_revision bigint,
  p_actor text,
  p_correlation_id text
)
returns platform.project_ownership_policies
language plpgsql
as $$
declare
  v_adapter text;
  v_exists boolean;
  v_policy platform.project_ownership_policies%rowtype;
begin
  if p_project_ref = '' or p_domain !~ '^[a-z][a-z0-9-]{0,63}$' or
     p_ownership_mode not in ('observe-only', 'direct-managed', 'gitops-managed') or
     p_expected_revision < 0 or p_actor = '' or p_correlation_id = '' then
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
      using errcode = '55000', detail = 'T8 direct-managed provider supports Compose and Kubernetes bindings';
  end if;

  select * into v_policy
  from platform.project_ownership_policies
  where project_ref = p_project_ref and domain = p_domain;
  v_exists := found;

  if v_exists then
    if v_policy.policy_revision <> p_expected_revision then
      raise exception 'configuration_conflict'
        using errcode = '40001', detail = 'expected ownership policy revision does not match';
    end if;
    update platform.project_ownership_policies set
      ownership_mode = p_ownership_mode,
      adapter = v_adapter,
      policy_revision = policy_revision + 1,
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
    if p_expected_revision <> 0 then
      raise exception 'configuration_conflict'
        using errcode = '40001', detail = 'expected ownership policy revision does not match';
    end if;
    insert into platform.project_ownership_policies (
      project_ref, domain, ownership_mode, adapter, policy_revision,
      drift_state, blockers, updated_by, updated_at
    ) values (
      p_project_ref, p_domain, p_ownership_mode, v_adapter, 1,
      'unknown', '[]'::jsonb, p_actor, now()
    ) returning * into v_policy;
  end if;

  update platform.stack_bindings set
    drift_state = 'unknown', status_observed_at = now()
  where project_ref = p_project_ref and attachment_state = 'active';

  insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
  values (p_actor, p_project_ref, 'fleet.ownership_policy.update', p_correlation_id,
    jsonb_build_object('domain', p_domain, 'ownership_mode', p_ownership_mode,
      'adapter', v_adapter, 'policy_revision', v_policy.policy_revision));

  return v_policy;
end;
$$;

create or replace function platform.apply_ownership_observation(
  p_project_ref text,
  p_domain text,
  p_policy_revision bigint,
  p_operation_id text,
  p_observed_generation bigint,
  p_observed_digest text,
  p_drift_state text,
  p_blockers jsonb,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
as $$
begin
  if p_drift_state not in ('in-sync', 'drifted', 'ownership-conflict') or
     p_observed_generation < 1 or p_observed_digest !~ '^[0-9a-f]{64}$' or
     jsonb_typeof(p_blockers) <> 'array' then
    raise exception 'invalid_ownership_observation' using errcode = '22023';
  end if;

  update platform.project_ownership_policies set
    drift_state = p_drift_state,
    blockers = p_blockers,
    last_operation_id = p_operation_id,
    last_observed_generation = p_observed_generation,
    last_observed_digest = p_observed_digest,
    last_observed_at = p_observed_at,
    updated_at = now()
  where project_ref = p_project_ref and domain = p_domain
    and policy_revision = p_policy_revision
    and (last_observed_generation is null or last_observed_generation <= p_observed_generation);
  if not found then return false; end if;

  update platform.stack_bindings stack set
    drift_state = case
      when exists (
        select 1 from platform.project_ownership_policies policy
        where policy.project_ref = p_project_ref and policy.drift_state = 'ownership-conflict'
      ) then 'ownership-conflict'
      when exists (
        select 1 from platform.project_ownership_policies policy
        where policy.project_ref = p_project_ref and policy.drift_state = 'drifted'
      ) then 'drifted'
      when not exists (
        select 1 from platform.project_ownership_policies policy
        where policy.project_ref = p_project_ref and policy.drift_state = 'unknown'
      ) then 'in-sync'
      else 'unknown'
    end,
    status_observed_at = p_observed_at
  where stack.project_ref = p_project_ref and stack.attachment_state = 'active';

  return true;
end;
$$;

-- Rollback/forward repair: policy rows are projections and may be dropped only
-- after callers stop using migration 15 functions. Runtime desired revisions,
-- operations, and Agent evidence remain intact in their owning stores.
