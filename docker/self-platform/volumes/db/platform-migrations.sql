-- [self-platform] Apply the platform control-plane migrations into _platform.
-- The migration files are mounted at /platform-migrations — deliberately
-- OUTSIDE /docker-entrypoint-initdb.d so the image entrypoint can never
-- auto-run them against the wrong database; this wrapper is the only executor.
-- Order matches lexical initdb order of the standalone platform-db mini-stack.
\c _platform

-- [self-platform] 01-schema.sql (mini-stack heritage) runs
-- `alter role postgres set search_path to public, auth` — cluster-wide.
-- Capture the image's pre-existing role-level search_path so it can be
-- restored verbatim after the migrations (the project database depends on
-- `extensions` being on that path for pg-meta/SQL-editor sessions).
select coalesce(
  (select regexp_replace(cfg, '^search_path=', '')
     from unnest((select setconfig from pg_db_role_setting
                   where setrole = 'postgres'::regrole and setdatabase = 0)) as u(cfg)
    where cfg like 'search_path=%'),
  '') as plt_saved_sp \gset
select (:'plt_saved_sp' <> '') as plt_has_sp \gset

-- [self-platform] Temporal elevation for the bootstrap window ONLY:
-- under `set role platform_admin`, that same `alter role postgres` needs
-- CREATEROLE + ADMIN OPTION on postgres (PG16+ rules). Granted here,
-- revoked below — platform_admin must NOT keep any path to superuser.
alter role platform_admin createrole;
grant postgres to platform_admin with admin option;

set role platform_admin;
\i /platform-migrations/01-schema.sql
\i /platform-migrations/02-projects.sql
\i /platform-migrations/03-analytics.sql
\i /platform-migrations/04-roles.sql
\i /platform-migrations/05-invitations.sql
\i /platform-migrations/05-mfa-enforcement.sql
\i /platform-migrations/06-auth-config.sql
\i /platform-migrations/07-stack-metadata.sql
\i /platform-migrations/08-health.sql
\i /platform-migrations/09-metrics.sql
\i /platform-migrations/10-container.sql
\i /platform-migrations/11-k8s-identity.sql
reset role;

-- [self-platform] Drop the temporal elevation.
revoke postgres from platform_admin;
alter role platform_admin nocreaterole;

-- [self-platform] Restore the postgres role's cluster-wide search_path.
-- Spliced unquoted on purpose: the captured value is postgres' own canonical
-- flattened list (elements already quoted as needed), so raw interpolation
-- restores it verbatim; a quoted :'...' would collapse it into one element.
\if :plt_has_sp
alter role postgres set search_path = :plt_saved_sp;
\else
alter role postgres reset search_path;
\endif

\c postgres
