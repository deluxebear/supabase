#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.migration-test.yml"
PROJECT_NAME="supabase-t6-honest-attachment-$RANDOM"

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up --wait platform-db
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" run --rm platform-migrate

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T platform-db \
  psql -v ON_ERROR_STOP=1 -U postgres -d platform <<'SQL'
create table public.managed_infrastructure_marker (
  id integer primary key,
  description text not null
);
insert into public.managed_infrastructure_marker values (1, 'must survive Fleet detach');

insert into platform.projects (
  ref, organization_id, name, status, db_host, db_port, db_name, db_user,
  db_user_readonly, kong_url, rest_url, db_pass_enc, service_key_enc,
  anon_key_enc, jwt_secret_enc, stack_kind, stack_meta, key_mode
) values
  ('stack-a', 1, 'Stack A', 'ACTIVE_HEALTHY', 'db-a', 5432, 'postgres',
   'supabase_admin', 'supabase_read_only_user', 'http://gateway-a',
   'http://gateway-a/rest/v1/', 'enc-db', 'enc-service', 'enc-anon', 'enc-jwt',
   'external', '{}'::jsonb, 'legacy-jwt'),
  ('stack-b', 1, 'Stack B', 'COMING_UP', 'db-b', 5432, 'postgres',
   'supabase_admin', 'supabase_read_only_user', 'http://gateway-b',
   'http://gateway-b/rest/v1/', 'enc-db', 'enc-service', 'enc-anon', 'enc-jwt',
   'external', '{}'::jsonb, 'legacy-jwt');

insert into platform.project_connection_revisions (
  project_ref, revision, state, key_mode, connection_document,
  stack_fingerprint, created_by, correlation_id, validated_at, activated_at
) values
  ('stack-a', 1, 'active', 'legacy-jwt', '{}'::jsonb, repeat('a', 64),
   'acceptance', 'acceptance-a', now(), now()),
  ('stack-b', 1, 'active', 'legacy-jwt', '{}'::jsonb, null,
   'acceptance', 'acceptance-b', now(), now());

insert into platform.stack_bindings (
  project_ref, stack_fingerprint, fingerprint_proof_state,
  active_connection_revision, key_mode, attachment_state, data_plane_health,
  management_connectivity, drift_state, operation_state
) values (
  'stack-a', repeat('a', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy',
  'offline', 'unknown', 'idle'
);

do $$
begin
  begin
    insert into platform.stack_bindings (
      project_ref, stack_fingerprint, fingerprint_proof_state,
      active_connection_revision, key_mode, attachment_state, data_plane_health,
      management_connectivity, drift_state, operation_state
    ) values (
      'stack-b', repeat('a', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy',
      'unconfigured', 'unknown', 'idle'
    );
    raise exception 'duplicate fingerprint was accepted';
  exception when unique_violation then
    null;
  end;
end;
$$;

insert into platform.project_capabilities (
  project_ref, name, state, mode, source, contract_version,
  observation_revision, observed_at, blockers
) values
  ('stack-a', 'project.detach', 'available', 'direct', 'preflight', 'v1',
   repeat('a', 64), now(), '[]'::jsonb),
  ('stack-a', 'project.connection.update', 'available', 'direct', 'preflight', 'v1',
   repeat('a', 64), now(), '[]'::jsonb);

select * from platform.commit_desired_configuration(
  'stack-a', 'auth', 'auth.config.apply', 0, 'stack-a-applied', 'target-a', 'binding-a',
  'supabase.fleet.auth.config.apply.v1', 'stack-a-applied-idem', '{"enabled":true}'::jsonb,
  '{}'::jsonb, 'acceptance-owner', 'stack-a-applied-correlation'
);
select * from platform.commit_desired_configuration(
  'stack-a', 'storage', 'storage.config.apply', 0, 'stack-a-observed', 'target-a', 'binding-a',
  'supabase.fleet.storage.config.apply.v1', 'stack-a-observed-idem', '{"enabled":true}'::jsonb,
  '{}'::jsonb, 'acceptance-owner', 'stack-a-observed-correlation'
);
update platform.operation_outbox
set delivery_state = 'dispatched'
where operation_id in ('stack-a-applied', 'stack-a-observed');
update platform.operation_summaries
set state = case operation_id
  when 'stack-a-applied' then 'applied'
  else 'observed'
end,
control_state = 'succeeded'
where operation_id in ('stack-a-applied', 'stack-a-observed');

select * from platform.detach_project('stack-a', 'acceptance-owner', 'acceptance-detach');

do $$
begin
  if not exists (select 1 from platform.projects where ref = 'stack-a') then
    raise exception 'detach deleted the project tombstone';
  end if;
  if not exists (
    select 1 from platform.stack_bindings
    where project_ref = 'stack-a'
      and attachment_state = 'detached'
      and target_cleanup_pending
  ) then
    raise exception 'offline target cleanup was not retained as pending';
  end if;
  if not exists (
    select 1 from platform.project_connection_revisions
    where project_ref = 'stack-a' and state = 'detached' and secrets_purge_after is not null
  ) then
    raise exception 'connection secret retention was not scheduled';
  end if;
  if not exists (
    select 1 from platform.audit_events
    where project_ref = 'stack-a'
      and action = 'fleet.project.detach'
      and payload->>'infrastructure_deleted' = 'false'
  ) then
    raise exception 'detach audit evidence is missing';
  end if;
  if not exists (select 1 from public.managed_infrastructure_marker where id = 1) then
    raise exception 'detach touched managed infrastructure';
  end if;
end;
$$;

insert into platform.stack_bindings (
  project_ref, stack_fingerprint, fingerprint_proof_state,
  active_connection_revision, key_mode, attachment_state, data_plane_health,
  management_connectivity, drift_state, operation_state
) values (
  'stack-b', repeat('a', 64), 'verified', 1, 'legacy-jwt', 'active', 'healthy',
  'unconfigured', 'unknown', 'idle'
);

select * from platform.commit_desired_configuration(
  'stack-b', 'auth', 'auth.config.apply', 0, 'stack-b-queued', 'target-b', 'binding-b',
  'supabase.fleet.auth.config.apply.v1', 'stack-b-queued-idem', '{"enabled":true}'::jsonb,
  '{}'::jsonb, 'acceptance-owner', 'stack-b-queued-correlation'
);

do $$
begin
  begin
    perform platform.detach_project('stack-b', 'acceptance-owner', 'acceptance-active-operation');
    raise exception 'detach accepted an active queued operation';
  exception when sqlstate '55000' then
    if sqlerrm <> 'operation_conflict' then raise; end if;
  end;
end;
$$;
SQL

echo "T6 honest attachment acceptance passed"
