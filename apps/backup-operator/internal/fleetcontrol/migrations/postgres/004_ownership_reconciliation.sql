alter table operations add column if not exists task_id text;
alter table operations add column if not exists agent_id text;
alter table operations add column if not exists evidence_schema text;
alter table operations add column if not exists evidence_json jsonb;
alter table operations add column if not exists error_code text;
alter table operations add column if not exists started_at_ms bigint;
alter table operations add column if not exists finished_at_ms bigint;

create unique index if not exists operations_task_id_idx on operations (task_id)
where task_id is not null;
create index if not exists operations_binding_queue_idx on operations (
  binding_id,
  state,
  created_at_ms
);
