create table if not exists platform.runtime_inventories (
  project_ref text primary key references platform.projects(ref) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  state text not null default 'pending' check (state in ('pending', 'refreshing', 'ready', 'failed')),
  operation_id text,
  evidence jsonb,
  error_code text,
  observed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (evidence is null or jsonb_typeof(evidence) = 'object')
);

create index if not exists runtime_inventories_operation_idx
  on platform.runtime_inventories(operation_id) where operation_id is not null;

alter table platform.runtime_inventories enable row level security;
revoke all on platform.runtime_inventories from public;
