create table if not exists platform.database_security_policies (
  project_ref text primary key references platform.projects(ref) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  ssl_enforced boolean not null default false,
  tls_ca_reference text,
  allowed_cidrs jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_cidrs) = 'array'),
  default_pool_size integer not null default 15 check (default_pool_size between 1 and 1000),
  max_client_connections integer not null default 200 check (max_client_connections between 10 and 100000),
  pool_mode text not null default 'transaction' check (pool_mode in ('transaction', 'session')),
  ignored_parameters jsonb not null default '[]'::jsonb check (jsonb_typeof(ignored_parameters) = 'array'),
  state text not null default 'ready' check (state in ('ready', 'applying', 'failed')),
  operation_id text,
  error_code text,
  observed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists database_security_policies_operation_idx
  on platform.database_security_policies(operation_id) where operation_id is not null;

alter table platform.database_security_policies enable row level security;
revoke all on platform.database_security_policies from public;
