-- 36-service-config.sql
-- [self-platform] Phase 2: per-project desired settings for services that read
-- their configuration from the environment at boot (PostgREST, Storage).
-- Desired state only: a setting becomes live when Studio applies it through
-- Fleet, which writes a Compose override and rolls the service out.
-- Idempotent — safe to re-run.

create table if not exists platform.service_config (
  project_ref text        not null
    references platform.projects (ref) on delete cascade,
  service     text        not null check (service ~ '^[a-z][a-z0-9-]{0,62}$'),
  config      jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (project_ref, service)
);

comment on table platform.service_config is
  '[self-platform] Phase 2: stored non-secret overrides per project and service. Desired state; applied through Fleet.';
