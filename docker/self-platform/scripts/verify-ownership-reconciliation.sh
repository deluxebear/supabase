#!/usr/bin/env bash
# Disposable T8 acceptance: platform policy authority, stale revision CAS,
# project isolation, and target-side ownership provider contracts.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${ROOT_DIR}/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.migration-test.yml"
PROJECT_NAME="supabase-t8-ownership-$RANDOM"

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
  ('ownership-a', 1, 'Ownership A', 'ACTIVE_HEALTHY', 'db-a', 5432, 'postgres',
   'admin', 'reader', 'http://gateway-a', 'http://gateway-a/rest/v1/',
   'enc', 'enc', 'enc', 'enc', 'external', '{}'::jsonb, 'legacy-jwt'),
  ('ownership-b', 1, 'Ownership B', 'ACTIVE_HEALTHY', 'db-b', 5432, 'postgres',
   'admin', 'reader', 'http://gateway-b', 'http://gateway-b/rest/v1/',
   'enc', 'enc', 'enc', 'enc', 'external', '{}'::jsonb, 'legacy-jwt');

insert into platform.project_connection_revisions (
  project_ref, revision, state, key_mode, connection_document, stack_fingerprint,
  created_by, correlation_id, validated_at, activated_at
) values
  ('ownership-a', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('a', 64), 'test', 'a', now(), now()),
  ('ownership-b', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('b', 64), 'test', 'b', now(), now());

insert into platform.stack_bindings (
  project_ref, stack_fingerprint, fingerprint_proof_state, active_connection_revision,
  key_mode, attachment_state, data_plane_health, management_connectivity, drift_state, operation_state
) values
  ('ownership-a', repeat('a', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy', 'online', 'unknown', 'idle'),
  ('ownership-b', repeat('b', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy', 'online', 'unknown', 'idle');

insert into platform.management_targets (
  id, organization_id, name, trust_domain, ca_reference,
  assertion_key_reference, created_by, correlation_id
) values
  ('00000000-0000-4000-8000-000000000008', 1, 'Ownership Target A', 'ownership-a.fleet.internal',
   'file:/run/secrets/fleet-management/ca.crt', 'env:FLEET_MANAGEMENT_ASSERTION_T8_A', 'test', 'a'),
  ('00000000-0000-4000-8000-000000000009', 1, 'Ownership Target B', 'ownership-b.fleet.internal',
   'file:/run/secrets/fleet-management/ca.crt', 'env:FLEET_MANAGEMENT_ASSERTION_T8_B', 'test', 'b');

insert into platform.project_management_bindings (
  id, project_ref, management_target_id, execution_target, deployment_kind,
  allowed_capability_prefixes, state, created_by, correlation_id
) values
  ('10000000-0000-4000-8000-000000000008', 'ownership-a', '00000000-0000-4000-8000-000000000008',
   'compose://ownership-a', 'compose', '["runtime."]'::jsonb, 'active', 'test', 'a'),
  ('10000000-0000-4000-8000-000000000009', 'ownership-b', '00000000-0000-4000-8000-000000000009',
   'kubernetes://prod/ownership-b', 'kubernetes', '["runtime."]'::jsonb, 'active', 'test', 'b');

update platform.stack_bindings set
  management_target_id = case project_ref
    when 'ownership-a' then '00000000-0000-4000-8000-000000000008'::uuid
    else '00000000-0000-4000-8000-000000000009'::uuid end,
  management_binding_id = case project_ref
    when 'ownership-a' then '10000000-0000-4000-8000-000000000008'::uuid
    else '10000000-0000-4000-8000-000000000009'::uuid end,
  execution_target = case project_ref
    when 'ownership-a' then 'compose://ownership-a'
    else 'kubernetes://prod/ownership-b' end,
  deployment_kind = case project_ref
    when 'ownership-a' then 'compose'
    else 'kubernetes' end
where project_ref in ('ownership-a', 'ownership-b');

select * from platform.set_project_ownership_policy(
  'ownership-a', 'auth', 'direct-managed', 1, 'owner-a', 'set-a'
);

select platform.apply_ownership_observation(
  'ownership-a', 'auth', 2, 'op-a', 1, repeat('c', 64),
  'ownership-conflict',
  '[{"code":"ownership_conflict","message":"user-owned Compose directory","remediation":"choose a Fleet-owned directory","resource":"compose.yaml"}]'::jsonb,
  now()
);

do $$
begin
  if not exists (
    select 1 from platform.project_ownership_policies
    where project_ref = 'ownership-a' and domain = 'auth'
      and ownership_mode = 'direct-managed' and adapter = 'compose'
      and drift_state = 'ownership-conflict'
      and jsonb_array_length(blockers) = 1
  ) then raise exception 'ownership conflict projection is missing'; end if;
  if not exists (
    select 1 from platform.stack_bindings
    where project_ref = 'ownership-a' and drift_state = 'ownership-conflict'
  ) then raise exception 'aggregate stack drift state is missing'; end if;
  if exists (
    select 1 from platform.project_ownership_policies
    where project_ref = 'ownership-b'
      and updated_by = 'owner-a'
  ) then raise exception 'project A policy leaked into project B'; end if;
  if not exists (
    select 1 from platform.audit_events
    where project_ref = 'ownership-a' and action = 'fleet.ownership_policy.update'
  ) then raise exception 'ownership policy audit is missing'; end if;
end;
$$;

select * from platform.set_project_ownership_policy(
  'ownership-b', 'storage', 'gitops-managed', 1, 'owner-b', 'set-b'
);
SQL

set +e
stale_output="$({
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T platform-db \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d platform \
      -c "select platform.set_project_ownership_policy('ownership-a','auth','gitops-managed',0,'owner-a','stale-a')"
} 2>&1)"
stale_status=$?
set -e
if [[ $stale_status -eq 0 || "$stale_output" != *configuration_conflict* ]]; then
  echo "stale ownership policy revision did not fail with configuration_conflict" >&2
  echo "$stale_output" >&2
  exit 1
fi

(cd "$REPO_DIR/apps/backup-operator" && \
  go test ./internal/fleetproviders ./internal/fleetagent ./internal/fleetcontrol \
    -run 'Ownership|Reconcile|OperationClaim' -count=1)

echo "T8 ownership-safe reconciliation acceptance passed"
