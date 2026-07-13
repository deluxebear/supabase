CREATE TABLE IF NOT EXISTS patroni_rollback_states (
  plan_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  state_json JSONB NOT NULL,
  rollback_until_ms BIGINT NOT NULL
);
