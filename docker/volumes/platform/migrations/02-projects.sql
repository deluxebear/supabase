-- Platform project registry (F9+F16 M2). Connection metadata for each
-- registered Supabase stack. Secret columns (*_enc) are AES-encrypted at
-- the application layer with PLATFORM_ENCRYPTION_KEY before insert.
create table platform.projects (
  id                  bigint generated always as identity primary key,
  ref                 text not null unique,
  organization_id     bigint not null references platform.organizations (id) on delete restrict,
  name                text not null,
  status              text not null default 'ACTIVE_HEALTHY',
  cloud_provider      text not null default 'AWS',
  region              text not null default 'local',
  db_host             text not null,
  db_port             integer not null default 5432,
  db_name             text not null default 'postgres',
  db_user             text not null default 'supabase_admin',
  db_user_readonly    text not null default 'supabase_read_only_user',
  kong_url            text not null,
  rest_url            text not null,
  db_pass_enc         text not null,
  service_key_enc     text not null,
  anon_key_enc        text not null,
  jwt_secret_enc      text not null,
  publishable_key_enc text,
  secret_key_enc      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
