-- Platform control-plane metadata, v1 (F9+F16 M1).
-- GoTrue owns the `auth` schema (auto-migrates on start); pre-create it so
-- the migration user does not need CREATE on the database.
create schema if not exists auth;

-- GoTrue's runtime queries reference some auth tables unqualified (relying on
-- search_path), same as the main stack's supabase_auth_admin role config.
-- Without this, new connections default to search_path "$user",public and
-- GoTrue signup fails with: relation "identities" does not exist (42P01).
alter role postgres set search_path to auth, public;

create schema if not exists platform;

create table platform.organizations (
  id bigint generated always as identity primary key,
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table platform.profiles (
  id bigint generated always as identity primary key,
  gotrue_id uuid not null unique,
  username text not null,
  primary_email text not null,
  first_name text,
  last_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table platform.organization_members (
  organization_id bigint not null references platform.organizations (id) on delete cascade,
  profile_id bigint not null references platform.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (organization_id, profile_id)
);

insert into platform.organizations (slug, name)
values ('default', 'Default Organization');
