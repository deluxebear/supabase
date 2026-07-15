alter table operations add column task_id text;
alter table operations add column agent_id text;
alter table operations add column evidence_schema text;
alter table operations add column evidence_json text;
alter table operations add column error_code text;
alter table operations add column started_at_ms integer;
alter table operations add column finished_at_ms integer;

create unique index if not exists operations_task_id_idx on operations (task_id)
where task_id is not null;
create index if not exists operations_binding_queue_idx on operations (
  binding_id,
  state,
  created_at_ms
);
