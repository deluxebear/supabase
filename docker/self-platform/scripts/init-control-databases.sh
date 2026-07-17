#!/usr/bin/env bash
set -Eeuo pipefail

for name in PGPASSWORD FLEET_CONTROL_POSTGRES_PASSWORD BACKUP_OPERATOR_POSTGRES_PASSWORD; do
  [ -n "${!name:-}" ] || {
    printf 'ERROR: %s is required\n' "$name" >&2
    exit 1
  }
done

psql -v ON_ERROR_STOP=1 \
  --set=fleet_password="$FLEET_CONTROL_POSTGRES_PASSWORD" \
  --set=backup_password="$BACKUP_OPERATOR_POSTGRES_PASSWORD" <<'SQL'
select format('create role fleet_control login password %L', :'fleet_password')
where not exists (select 1 from pg_roles where rolname = 'fleet_control') \gexec
select format('alter role fleet_control with login password %L', :'fleet_password') \gexec

select format('create role backup_operator login password %L', :'backup_password')
where not exists (select 1 from pg_roles where rolname = 'backup_operator') \gexec
select format('alter role backup_operator with login password %L', :'backup_password') \gexec

select 'create database fleet_control owner fleet_control'
where not exists (select 1 from pg_database where datname = 'fleet_control') \gexec
select 'alter database fleet_control owner to fleet_control' \gexec

select 'create database backup_operator owner backup_operator'
where not exists (select 1 from pg_database where datname = 'backup_operator') \gexec
select 'alter database backup_operator owner to backup_operator' \gexec
SQL

psql -v ON_ERROR_STOP=1 --dbname=fleet_control <<'SQL'
grant all on schema public to fleet_control;
SQL

psql -v ON_ERROR_STOP=1 --dbname=backup_operator <<'SQL'
grant all on schema public to backup_operator;
SQL
