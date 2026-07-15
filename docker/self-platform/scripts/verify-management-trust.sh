#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${ROOT_DIR}/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.migration-test.yml"
PROJECT_NAME="supabase-t7-management-trust-$RANDOM"

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up --wait platform-db
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" run --rm platform-migrate

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T platform-db \
  psql -v ON_ERROR_STOP=1 -U postgres -d platform <<'SQL'
insert into platform.organizations (slug, name) values ('org-b', 'Organization B');

insert into platform.projects (
  ref, organization_id, name, status, db_host, db_port, db_name, db_user,
  db_user_readonly, kong_url, rest_url, db_pass_enc, service_key_enc,
  anon_key_enc, jwt_secret_enc, stack_kind, stack_meta, key_mode
) values
  ('trust-a', 1, 'Trust A', 'ACTIVE_HEALTHY', 'db-a', 5432, 'postgres',
   'admin', 'reader', 'http://gateway-a', 'http://gateway-a/rest/v1/',
   'enc', 'enc', 'enc', 'enc', 'external', '{}'::jsonb, 'legacy-jwt'),
  ('trust-b', 2, 'Trust B', 'ACTIVE_HEALTHY', 'db-b', 5432, 'postgres',
   'admin', 'reader', 'http://gateway-b', 'http://gateway-b/rest/v1/',
   'enc', 'enc', 'enc', 'enc', 'external', '{}'::jsonb, 'legacy-jwt');

insert into platform.project_connection_revisions (
  project_ref, revision, state, key_mode, connection_document, stack_fingerprint,
  created_by, correlation_id, validated_at, activated_at
) values
  ('trust-a', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('a', 64), 'test', 'a', now(), now()),
  ('trust-b', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('b', 64), 'test', 'b', now(), now());

insert into platform.stack_bindings (
  project_ref, stack_fingerprint, fingerprint_proof_state, active_connection_revision,
  key_mode, attachment_state, data_plane_health, management_connectivity, drift_state, operation_state
) values
  ('trust-a', repeat('a', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy', 'unconfigured', 'unknown', 'idle'),
  ('trust-b', repeat('b', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy', 'unconfigured', 'unknown', 'idle');

insert into platform.management_targets (
  id, organization_id, name, trust_domain, ca_reference,
  assertion_key_reference, created_by, correlation_id
) values
  ('00000000-0000-4000-8000-00000000000a', 1, 'Target A', 'a.fleet.internal',
   'file:/run/secrets/fleet-management/ca.crt', 'env:FLEET_MANAGEMENT_ASSERTION_A', 'test', 'a'),
  ('00000000-0000-4000-8000-00000000000b', 2, 'Target B', 'b.fleet.internal',
   'file:/run/secrets/fleet-management/ca.crt', 'env:FLEET_MANAGEMENT_ASSERTION_B', 'test', 'b');

insert into platform.management_target_domains (
  management_target_id, domain, api_url, audience, contract_version, capability_schema_prefix
) values
  ('00000000-0000-4000-8000-00000000000a', 'fleet-control', 'https://fleet-a:8091', 'fleet-a', 'v1', 'supabase.fleet.'),
  ('00000000-0000-4000-8000-00000000000b', 'fleet-control', 'https://fleet-b:8091', 'fleet-b', 'v1', 'supabase.fleet.');

do $$
begin
  begin
    perform platform.bind_management_target(
      'trust-a', '00000000-0000-4000-8000-00000000000b', 'compose://a',
      'compose', '["runtime."]'::jsonb, 'test', 'wrong-target'
    );
    raise exception 'cross-organization management target was accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select platform.bind_management_target(
  'trust-a', '00000000-0000-4000-8000-00000000000a', 'compose://a',
  'compose', '["runtime."]'::jsonb, 'test', 'bind-a'
);
select platform.bind_management_target(
  'trust-b', '00000000-0000-4000-8000-00000000000b', 'compose://b',
  'compose', '["backup."]'::jsonb, 'test', 'bind-b'
);

do $$
declare binding_id uuid;
begin
  select id into binding_id from platform.project_management_bindings where project_ref = 'trust-a';
  perform platform.revoke_management_binding('trust-a', binding_id, 'test', 'revoke-a', false);
  if not exists (
    select 1 from platform.stack_bindings
    where project_ref = 'trust-a' and target_cleanup_pending and management_connectivity = 'revoked'
  ) then
    raise exception 'offline target cleanup tombstone is missing';
  end if;
  if not exists (
    select 1 from platform.audit_events
    where project_ref = 'trust-a' and action = 'fleet.management_binding.revoke'
  ) then
    raise exception 'management revocation audit is missing';
  end if;
  if not exists (
    select 1 from platform.project_capabilities
    where project_ref = 'trust-a' and name = 'management.target.bind' and state = 'available'
  ) then
    raise exception 'management target rebind capability was not restored';
  end if;
end;
$$;
SQL

(cd "$REPO_DIR/apps/backup-operator" && go test ./internal/fleetcontrol -run 'TestEnrollment|TestEnrollmentRejects')
echo "T7 management trust acceptance passed"
