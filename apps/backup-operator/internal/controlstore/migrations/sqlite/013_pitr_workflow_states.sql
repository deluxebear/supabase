CREATE TABLE IF NOT EXISTS pitr_workflow_states (
  target_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
