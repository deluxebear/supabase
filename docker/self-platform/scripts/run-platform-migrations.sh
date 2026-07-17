#!/usr/bin/env bash
# Applies the platform schema in lexical order under one PostgreSQL advisory
# lock. The ledger rejects edited or removed migrations and is the readiness
# boundary for Studio/platform-auth startup.
set -Eeuo pipefail

MIGRATIONS_DIR="${PLATFORM_MIGRATIONS_DIR:-/platform-migrations}"
MODE="${1:-migrate}"
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"

if [[ "$MODE" != "migrate" && "$MODE" != "check" ]]; then
  echo "usage: $0 [migrate|check]" >&2
  exit 2
fi
if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "platform migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 2
fi

mapfile -d '' migration_files < <(
  find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z
)
if (( ${#migration_files[@]} == 0 )); then
  echo "no platform migrations found in $MIGRATIONS_DIR" >&2
  exit 2
fi

sql_file="$(mktemp)"
trap 'rm -f "$sql_file"' EXIT

cat >"$sql_file" <<'SQL'
\set ON_ERROR_STOP on
select pg_advisory_lock(19088743, 5);
create schema if not exists platform;
create table if not exists platform.schema_migrations (
  version text primary key,
  name text not null unique,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
create temporary table expected_platform_migrations (
  version text primary key,
  name text not null,
  checksum text not null
) on commit preserve rows;
SQL

for migration_file in "${migration_files[@]}"; do
  name="$(basename "$migration_file")"
  if [[ ! "$name" =~ ^[0-9]{2}-[a-z0-9-]+\.sql$ ]]; then
    echo "invalid platform migration filename: $name" >&2
    exit 2
  fi
  version="${name%.sql}"
  checksum="$(sha256sum "$migration_file" | awk '{print $1}')"
  printf "insert into expected_platform_migrations values ('%s', '%s', '%s');\n" \
    "$version" "$name" "$checksum" >>"$sql_file"
  printf "select exists(select 1 from platform.schema_migrations where version='%s') as migration_known, coalesce((select checksum='%s' from platform.schema_migrations where version='%s'), false) as migration_checksum_matches \\gset\n" \
    "$version" "$checksum" "$version" >>"$sql_file"
  cat >>"$sql_file" <<SQL
\if :migration_known
  \if :migration_checksum_matches
    \echo 'platform migration $name already applied'
  \else
    \echo 'platform migration checksum changed: $name'
    select 1 / 0;
  \endif
\else
SQL
  if [[ "$MODE" == "check" ]]; then
    cat >>"$sql_file" <<SQL
  \echo 'required platform migration is missing: $name'
  select 1 / 0;
SQL
  else
    cat >>"$sql_file" <<SQL
  \echo 'applying platform migration $name'
  begin;
  \i '$migration_file'
  insert into platform.schema_migrations(version, name, checksum)
  values ('$version', '$name', '$checksum');
  commit;
SQL
  fi
  printf '\\endif\n' >>"$sql_file"
done

cat >>"$sql_file" <<'SQL'
select not exists (
  select 1
  from platform.schema_migrations applied
  left join expected_platform_migrations expected using (version)
  where expected.version is null
) as no_removed_migrations \gset
\if :no_removed_migrations
\else
  \echo 'the platform migration ledger contains a migration missing from the image'
  select 1 / 0;
\endif
SQL

psql_args=(-X --no-psqlrc -v ON_ERROR_STOP=1 -f "$sql_file")
if [[ -n "${PLATFORM_OUTBOX_DISPATCHER_PASSWORD:-}" ]]; then
  cat >>"$sql_file" <<'SQL'
\set dispatcher_password `printf '%s' "$PLATFORM_OUTBOX_DISPATCHER_PASSWORD"`
select format(
  'create role fleet_platform_dispatcher login password %L',
  :'dispatcher_password'
) where not exists (
  select 1 from pg_roles where rolname = 'fleet_platform_dispatcher'
) \gexec
select format(
  'alter role fleet_platform_dispatcher login password %L',
  :'dispatcher_password'
) \gexec
grant usage on schema platform to fleet_platform_dispatcher;
grant execute on function platform.claim_operation_outbox(text, integer) to fleet_platform_dispatcher;
grant execute on function platform.complete_operation_dispatch(text, text, text) to fleet_platform_dispatcher;
grant execute on function platform.fail_operation_dispatch(text, text, text, text, boolean) to fleet_platform_dispatcher;
grant select on platform.function_deployments, platform.operation_outbox to fleet_platform_dispatcher;
grant execute on function platform.apply_function_deployment_observation(text, text, text, uuid, bigint, text, text, text, text, text, timestamptz) to fleet_platform_dispatcher;
grant execute on function platform.apply_function_deployment_observation(text, text, text, uuid, bigint, text, text, text, text, text, timestamptz, jsonb) to fleet_platform_dispatcher;
grant execute on function platform.next_configuration_projection() to fleet_platform_dispatcher;
grant execute on function platform.apply_configuration_reconciliation_evidence(text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean, jsonb, text, timestamptz) to fleet_platform_dispatcher;
grant execute on function platform.apply_configuration_operation_failure(text, text, uuid, bigint, text) to fleet_platform_dispatcher;
SQL
fi

cat >>"$sql_file" <<'SQL'
select pg_advisory_unlock(19088743, 5);
SQL

psql "${psql_args[@]}"
echo "platform migrations are ready (${#migration_files[@]} files)"
