#!/usr/bin/env bash
# Disposable T9 acceptance: project-isolated references, idempotent CAS commits,
# rollback/manual-intervention projection, and target-side artifact providers.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${ROOT_DIR}/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.migration-test.yml"
PROJECT_NAME="supabase-t9-functions-$RANDOM"

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up --wait platform-db
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" run --rm platform-migrate

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T platform-db \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d platform <<'SQL'
insert into platform.projects (
  ref, organization_id, name, status, db_host, db_port, db_name, db_user,
  db_user_readonly, kong_url, rest_url, db_pass_enc, service_key_enc,
  anon_key_enc, jwt_secret_enc, stack_kind, stack_meta, key_mode
) values
  ('functions-a', 1, 'Functions A', 'ACTIVE_HEALTHY', 'db-a', 5432, 'postgres',
   'admin', 'reader', 'http://gateway-a', 'http://gateway-a/rest/v1/',
   'enc', 'enc', 'enc', 'enc', 'external', '{}'::jsonb, 'legacy-jwt'),
  ('functions-b', 1, 'Functions B', 'ACTIVE_HEALTHY', 'db-b', 5432, 'postgres',
   'admin', 'reader', 'http://gateway-b', 'http://gateway-b/rest/v1/',
   'enc', 'enc', 'enc', 'enc', 'external', '{}'::jsonb, 'legacy-jwt');

insert into platform.project_connection_revisions (
  project_ref, revision, state, key_mode, connection_document, stack_fingerprint,
  created_by, correlation_id, validated_at, activated_at
) values
  ('functions-a', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('a', 64), 'test', 'a', now(), now()),
  ('functions-b', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('b', 64), 'test', 'b', now(), now());

insert into platform.stack_bindings (
  project_ref, stack_fingerprint, fingerprint_proof_state, active_connection_revision,
  key_mode, attachment_state, data_plane_health, management_connectivity, drift_state, operation_state
) values
  ('functions-a', repeat('a', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy', 'online', 'unknown', 'idle'),
  ('functions-b', repeat('b', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy', 'online', 'unknown', 'idle');

insert into platform.management_targets (
  id, organization_id, name, trust_domain, ca_reference,
  assertion_key_reference, created_by, correlation_id
) values
  ('00000000-0000-4000-8000-000000000019', 1, 'Functions Target A', 'functions-a.fleet.internal',
   'file:/run/secrets/fleet-management/ca.crt', 'env:FLEET_MANAGEMENT_ASSERTION_T9_A', 'test', 'a'),
  ('00000000-0000-4000-8000-000000000029', 1, 'Functions Target B', 'functions-b.fleet.internal',
   'file:/run/secrets/fleet-management/ca.crt', 'env:FLEET_MANAGEMENT_ASSERTION_T9_B', 'test', 'b');

insert into platform.project_management_bindings (
  id, project_ref, management_target_id, execution_target, deployment_kind,
  allowed_capability_prefixes, state, created_by, correlation_id
) values
  ('10000000-0000-4000-8000-000000000019', 'functions-a', '00000000-0000-4000-8000-000000000019',
   'compose://functions-a', 'compose', '["functions."]'::jsonb, 'active', 'test', 'a'),
  ('10000000-0000-4000-8000-000000000029', 'functions-b', '00000000-0000-4000-8000-000000000029',
   'kubernetes://prod/functions-b', 'kubernetes', '["functions."]'::jsonb, 'active', 'test', 'b');

update platform.stack_bindings set
  management_target_id = case project_ref
    when 'functions-a' then '00000000-0000-4000-8000-000000000019'::uuid
    else '00000000-0000-4000-8000-000000000029'::uuid end,
  management_binding_id = case project_ref
    when 'functions-a' then '10000000-0000-4000-8000-000000000019'::uuid
    else '10000000-0000-4000-8000-000000000029'::uuid end,
  execution_target = case project_ref
    when 'functions-a' then 'compose://functions-a'
    else 'kubernetes://prod/functions-b' end,
  deployment_kind = case project_ref when 'functions-a' then 'compose' else 'kubernetes' end
where project_ref in ('functions-a', 'functions-b');

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
) select ref, 'functions.deploy', 'available', 'agent', 'agent', 'v1', 'agent-t9', now(), '[]'::jsonb
from platform.projects where ref in ('functions-a', 'functions-b');

select * from platform.set_project_ownership_policy(
  'functions-a', 'functions', 'direct-managed', 1, 'owner-a', 'policy-a'
);
select * from platform.set_project_ownership_policy(
  'functions-b', 'functions', 'direct-managed', 1, 'owner-b', 'policy-b'
);

do $$
begin
  update platform.project_capabilities set valid_until = now() - interval '1 second'
  where project_ref = 'functions-a' and name = 'functions.deploy';
  begin
    perform * from platform.commit_function_deployment(
      'functions-a', 'hello', 'deploy', repeat('0', 64), 122, 'index.ts', '', '[]'::jsonb,
      true, 0, 'op-expired', 'idem-expired', 'user-a', 'request-expired'
    );
    raise exception 'expired function capability was accepted';
  exception when sqlstate '55000' then
    if sqlerrm <> 'capability_unavailable' then raise; end if;
  end;
  update platform.project_capabilities set valid_until = null
  where project_ref = 'functions-a' and name = 'functions.deploy';

  update platform.management_targets set state = 'disabled'
  where id = '00000000-0000-4000-8000-000000000019';
  begin
    perform * from platform.commit_function_deployment(
      'functions-a', 'hello', 'deploy', repeat('0', 64), 122, 'index.ts', '', '[]'::jsonb,
      true, 0, 'op-disabled', 'idem-disabled', 'user-a', 'request-disabled'
    );
    raise exception 'disabled function management target was accepted';
  exception when sqlstate '55000' then
    if sqlerrm <> 'management_target_unbound' then raise; end if;
  end;
  update platform.management_targets set state = 'active'
  where id = '00000000-0000-4000-8000-000000000019';
end;
$$;

select * from platform.commit_function_deployment(
  'functions-a', 'hello', 'deploy', repeat('1', 64), 123, 'index.ts', '', '[]'::jsonb,
  true, 0, 'op-a-1', 'idem-a-1', 'user-a', 'request-a-1'
);
select * from platform.commit_function_deployment(
  'functions-a', 'hello', 'deploy', repeat('1', 64), 123, 'index.ts', '', '[]'::jsonb,
  true, 0, 'ignored-on-replay', 'idem-a-1', 'user-a', 'request-a-replay'
);

do $$
declare
  deployment platform.function_deployments%rowtype;
begin
  select * into deployment from platform.function_deployments
  where project_ref = 'functions-a' and slug = 'hello';
  if deployment.generation <> 1 or deployment.state <> 'queued' or
     deployment.desired_artifact_digest <> repeat('1', 64) then
    raise exception 'initial function deployment was not committed';
  end if;
  if (select count(*) from platform.operation_outbox where project_ref = 'functions-a') <> 1 then
    raise exception 'idempotent replay created another operation';
  end if;
  if exists (select 1 from platform.function_artifact_references where project_ref = 'functions-b') then
    raise exception 'project A artifact reference leaked into project B';
  end if;
  if not platform.apply_function_deployment_observation(
    'functions-a', 'hello', deployment.operation_id, deployment.desired_revision,
    deployment.generation, 'active', repeat('1', 64), '', '', '', now()
    , jsonb_build_object(
      'schema', 'supabase.fleet.functions.deploy.evidence.v1',
      'status', 'active', 'adapter', 'compose', 'slug', 'hello',
      'artifactDigest', repeat('1', 64), 'observedGeneration', deployment.generation,
      'probe', jsonb_build_object('succeeded', true, 'message', 'Invocation probe passed'),
      'activatedAt', now()
    )
  ) then raise exception 'active observation was rejected'; end if;
  if not exists (
    select 1 from platform.function_deployments
    where project_ref = 'functions-a' and slug = 'hello'
      and evidence->'probe'->>'message' = 'Invocation probe passed'
  ) then raise exception 'typed function evidence was not persisted'; end if;
  begin
    perform platform.apply_function_deployment_observation(
      'functions-a', 'hello', deployment.operation_id, deployment.desired_revision,
      deployment.generation, 'active', repeat('1', 64), '', '', '', now(),
      jsonb_build_object(
        'schema', 'supabase.fleet.functions.deploy.evidence.v1',
        'status', 'active', 'adapter', 'compose', 'slug', 'hello',
        'artifactDigest', repeat('1', 64),
        'probe', jsonb_build_object('succeeded', true), 'activatedAt', now()
      )
    );
    raise exception 'malformed typed function evidence was accepted';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

select * from platform.commit_function_deployment(
  'functions-a', 'hello', 'deploy', repeat('2', 64), 124, 'index.ts', '', '[]'::jsonb,
  true, 1, 'op-a-2', 'idem-a-2', 'user-a', 'request-a-2'
);

do $$
declare
  deployment platform.function_deployments%rowtype;
begin
  select * into deployment from platform.function_deployments
  where project_ref = 'functions-a' and slug = 'hello';
  if not platform.apply_function_deployment_observation(
    'functions-a', 'hello', deployment.operation_id, deployment.desired_revision,
    deployment.generation, 'rolled-back', repeat('1', 64), repeat('1', 64),
    'rollout_probe_failed', 'inspect rollout', now()
  ) then raise exception 'rollback observation was rejected'; end if;
  select * into deployment from platform.function_deployments
  where project_ref = 'functions-a' and slug = 'hello';
  if deployment.state <> 'rolled-back' or deployment.active_artifact_digest <> repeat('1', 64) then
    raise exception 'failed probe did not retain the previous active artifact';
  end if;
end;
$$;

select * from platform.commit_function_deployment(
  'functions-a', 'hello', 'deploy', repeat('3', 64), 125, 'index.ts', '', '[]'::jsonb,
  true, 2, 'op-a-3', 'idem-a-3', 'user-a', 'request-a-3'
);

do $$
declare
  deployment platform.function_deployments%rowtype;
begin
  select * into deployment from platform.function_deployments
  where project_ref = 'functions-a' and slug = 'hello';
  if not platform.apply_function_deployment_observation(
    'functions-a', 'hello', deployment.operation_id, deployment.desired_revision,
    deployment.generation, 'manual-intervention', repeat('3', 64), repeat('1', 64),
    'manual_intervention_required', 'restore prior pointer', now()
  ) then raise exception 'manual intervention observation was rejected'; end if;
  select * into deployment from platform.function_deployments
  where project_ref = 'functions-a' and slug = 'hello';
  if deployment.state <> 'manual-intervention' or deployment.active_artifact_digest <> repeat('1', 64) then
    raise exception 'manual intervention overwrote the last known active artifact';
  end if;
  if platform.apply_function_deployment_observation(
    'functions-b', 'hello', deployment.operation_id, deployment.desired_revision,
    deployment.generation, 'active', repeat('3', 64), repeat('1', 64), '', '', now()
  ) then raise exception 'cross-project observation was accepted'; end if;
  if not exists (
    select 1 from platform.audit_events
    where project_ref = 'functions-a' and action = 'fleet.function.deploy'
  ) then raise exception 'function deployment audit is missing'; end if;
end;
$$;
SQL

set +e
conflict_output="$({
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T platform-db \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d platform -c \
      "select * from platform.commit_function_deployment('functions-a','other','deploy',repeat('4',64),126,'index.ts','','[]'::jsonb,true,0,'op-other','idem-a-1','user-a','request-conflict')"
} 2>&1)"
conflict_status=$?
set -e
if [[ $conflict_status -eq 0 || "$conflict_output" != *idempotency_conflict* ]]; then
  echo "mismatched idempotency replay did not fail closed" >&2
  echo "$conflict_output" >&2
  exit 1
fi

(cd "$REPO_DIR/apps/backup-operator" && \
  go test ./internal/fleetfunctions ./internal/fleetagent ./internal/fleetcontrol ./internal/fleetplatform \
    -run 'Function|Artifact|KubernetesLarge|Projection' -count=1)

echo "T9 Edge Functions Fleet deployment acceptance passed"
