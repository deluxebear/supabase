CREATE TABLE IF NOT EXISTS pitr_workflow_states (
  target_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL,
  phase TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
