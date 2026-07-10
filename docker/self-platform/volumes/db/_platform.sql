-- [self-platform] Control-plane database inside the shared cluster.
-- Mirrors ../../../volumes/db/_supabase.sql (the `_supabase` pattern).
-- Runs only on a fresh PGDATA via docker-entrypoint-initdb.d; existing
-- volumes are handled by scripts/bootstrap.sh phase 1.
\set platform_pass `echo "$PLATFORM_POSTGRES_PASSWORD"`

create role platform_admin login createrole password :'platform_pass';
grant postgres to platform_admin with admin option;
create database _platform with owner platform_admin;
-- GoTrue DDL defaults to public; unqualified lookups must fall through to
-- auth (M1 Task-4 lesson — see docker/volumes/platform/migrations/01-schema.sql).
alter role platform_admin in database _platform set search_path = public, auth;
