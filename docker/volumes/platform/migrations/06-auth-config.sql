-- 06-auth-config.sql
-- [self-platform] F9+F16 M4: per-project GoTrue auth config store.
-- Non-secret fields live in `config`; secret fields (provider/SMTP/hook/SMS/captcha)
-- are AES-encrypted (PLATFORM_ENCRYPTION_KEY, same scheme as platform.projects)
-- and live in `secrets`. This is a DESIRED-STATE store: GoTrue reads env at boot,
-- so changes here are not live until `apply-auth-config <ref>` is run.
-- Idempotent — safe to re-run.

create table if not exists platform.auth_config (
  project_ref text primary key
    references platform.projects (ref) on delete cascade,
  config      jsonb        not null default '{}'::jsonb,
  secrets     jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  text
);

comment on table platform.auth_config is
  '[self-platform] M4: per-project GoTrue config store (config=non-secret, secrets=AES-encrypted). Desired state; apply via apply-auth-config.';
