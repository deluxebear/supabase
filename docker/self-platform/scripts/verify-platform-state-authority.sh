#!/usr/bin/env bash
# Disposable Compose acceptance test for platform migrations, state CAS, and T10 capacity.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f docker-compose.migration-test.yml)
expected_migrations=$(find ../volumes/platform/migrations -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

wait_for_db() {
  "${compose[@]}" up -d --wait platform-db
}

psql_test() {
  "${compose[@]}" exec -T platform-db psql -X -v ON_ERROR_STOP=1 -U postgres -d platform "$@"
}

echo '== upgrade from the pre-ledger platform schema =='
wait_for_db
for migration in ../volumes/platform/migrations/{01-schema,02-projects,03-analytics,04-roles,05-invitations,05-mfa-enforcement,06-auth-config,07-stack-metadata,08-health,09-metrics,10-container,11-k8s-identity}.sql; do
  psql_test <"$migration" >/dev/null
done
"${compose[@]}" run --rm platform-migrate
psql_test -tAc "select count(*) = $expected_migrations from platform.schema_migrations" | grep -qx t

echo '== fresh migration, concurrent replay, desired/outbox/CAS =='
cleanup
wait_for_db
"${compose[@]}" run --rm platform-migrate &
first_pid=$!
"${compose[@]}" run --rm platform-migrate &
second_pid=$!
wait "$first_pid"
wait "$second_pid"

psql_test <<'SQL'
insert into platform.projects (
  ref, organization_id, name, db_host, kong_url, rest_url, db_pass_enc,
  service_key_enc, anon_key_enc, jwt_secret_enc
) select 'project-a', id, 'Project A', 'db', 'http://kong', 'http://kong/rest/v1',
  'encrypted', 'encrypted', 'encrypted', 'encrypted'
from platform.organizations where slug='default';

select * from platform.commit_desired_configuration(
  'project-a','auth','auth.config.apply',0,'op-1','target-a','binding-a',
  'supabase.fleet.auth.config.apply.v1','idem-1','{"enabled":true}'::jsonb,
  '{}'::jsonb,'user-a','request-1'
);
select * from platform.commit_desired_configuration(
  'project-a','auth','auth.config.apply',0,'op-1','target-a','binding-a',
  'supabase.fleet.auth.config.apply.v1','idem-1','{"enabled":true}'::jsonb,
  '{}'::jsonb,'user-a','request-1'
);
select * from platform.commit_desired_configuration(
  'project-a','auth','auth.config.apply',1,'op-2','target-a','binding-a',
  'supabase.fleet.auth.config.apply.v1','idem-2','{"enabled":false}'::jsonb,
  '{}'::jsonb,'user-a','request-2'
);

do $$
declare
  old_revision uuid;
  current_revision uuid;
  claimed_operation_id text;
  applied boolean;
begin
  if (select state from platform.operation_summaries where operation_id='op-1') <> 'superseded' then
    raise exception 'older queued operation was not superseded';
  end if;
  select operation_id into claimed_operation_id
  from platform.claim_operation_outbox('acceptance-worker', 30);
  if claimed_operation_id <> 'op-2' then
    raise exception 'dispatcher claimed %, expected current operation op-2', claimed_operation_id;
  end if;
  if not platform.complete_operation_dispatch('op-2', 'acceptance-worker', 'queued') then
    raise exception 'current operation dispatch completion failed';
  end if;
  select desired_revision into old_revision from platform.operation_outbox where operation_id='op-1';
  select desired_revision into current_revision from platform.operation_outbox where operation_id='op-2';
  select platform.apply_configuration_observation(
    'project-a','auth',old_revision,1,'{"enabled":true}'::jsonb,'op-1',now()
  ) into applied;
  if applied then raise exception 'stale observation was accepted'; end if;
  select platform.apply_configuration_observation(
    'project-a','auth',current_revision,2,'{"enabled":false}'::jsonb,'op-2',now()
  ) into applied;
  if not applied then raise exception 'current observation was rejected'; end if;
end;
$$;

do $$
begin
  if (select count(*) from platform.configuration_revisions where project_ref='project-a') <> 2 then
    raise exception 'revision count mismatch';
  end if;
  if (select count(*) from platform.operation_outbox where project_ref='project-a') <> 2 then
    raise exception 'outbox replay created a duplicate';
  end if;
  if (select observed_generation from platform.project_observations where project_ref='project-a' and domain='auth') <> 2 then
    raise exception 'CAS observation mismatch';
  end if;
end;
$$;

-- T10 capacity is enforced transactionally at the platform authority before
-- work enters Fleet Control. Terminal dispatched history does not consume the
-- bounded live queue.
update platform.operation_outbox set delivery_state='dispatched' where operation_id in ('op-1','op-2');
update platform.operation_summaries set state='applied' where operation_id in ('op-1','op-2');
set platform.fleet_max_queued_per_target = '2';
select * from platform.commit_desired_configuration(
  'project-a','auth','auth.config.apply',2,'op-3','target-a','binding-a',
  'supabase.fleet.auth.config.apply.v1','idem-3','{"enabled":true}'::jsonb,
  '{}'::jsonb,'user-a','request-3'
);
select * from platform.commit_desired_configuration(
  'project-a','storage','storage.config.apply',0,'op-4','target-a','binding-a',
  'supabase.fleet.storage.config.apply.v1','idem-4','{"enabled":false}'::jsonb,
  '{}'::jsonb,'user-a','request-4'
);
do $$
begin
  perform platform.commit_desired_configuration(
    'project-a','realtime','realtime.config.apply',0,'op-5','target-a','binding-a',
    'supabase.fleet.realtime.config.apply.v1','idem-5','{"enabled":true}'::jsonb,
    '{}'::jsonb,'user-a','request-5'
  );
  raise exception 'target capacity limit was not enforced';
exception
  when sqlstate '54000' then
    if sqlerrm <> 'capacity_exceeded' then raise; end if;
end;
$$;
SQL

echo '== changed checksum fails readiness =='
psql_test -c "update platform.schema_migrations set checksum=repeat('0',64) where version='12-state-authority'" >/dev/null
if "${compose[@]}" run --rm platform-migrate; then
  echo 'changed platform migration checksum was accepted' >&2
  exit 1
fi

echo 'Platform migration/state-authority/capacity acceptance passed'
