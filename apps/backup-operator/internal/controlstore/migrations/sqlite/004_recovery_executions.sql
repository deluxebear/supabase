CREATE TABLE IF NOT EXISTS recovery_executions (
  plan_id TEXT PRIMARY KEY REFERENCES restore_plans(id),
  state TEXT NOT NULL,
  original_pgdata TEXT NOT NULL DEFAULT '',
  failed_pgdata TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  fencing_token INTEGER NOT NULL,
  fence_handle_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_executions_state
  ON recovery_executions(state, updated_at_ms);
