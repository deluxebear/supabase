alter table operations add column attempts integer not null default 0;
alter table operations add column deadline_at_ms integer not null default 0;

update operations
set state = case state
  when 'applying' then 'running'
  when 'applied' then 'succeeded'
  when 'manual_intervention' then 'failed'
  else state
end;

update operations
set deadline_at_ms = created_at_ms + 900000
where deadline_at_ms = 0;

create table if not exists operation_attempts (
  operation_id text not null references operations(id),
  attempt integer not null check (attempt > 0),
  task_id text not null unique,
  agent_id text not null,
  state text not null,
  started_at_ms integer not null,
  finished_at_ms integer,
  evidence_schema text,
  evidence_json text,
  error_code text,
  primary key (operation_id, attempt)
);

insert or ignore into operation_attempts (
  operation_id, attempt, task_id, agent_id, state, started_at_ms,
  finished_at_ms, evidence_schema, evidence_json, error_code
)
select id, 1, task_id, agent_id, state, coalesce(started_at_ms, updated_at_ms),
  finished_at_ms, evidence_schema, evidence_json, error_code
from operations
where task_id is not null;

update operations set attempts = 1 where task_id is not null and attempts = 0;

create index if not exists operation_attempts_operation_idx
  on operation_attempts (operation_id, attempt);
create index if not exists operations_deadline_idx
  on operations (state, deadline_at_ms);
