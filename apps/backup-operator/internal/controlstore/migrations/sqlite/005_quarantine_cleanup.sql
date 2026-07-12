CREATE TABLE IF NOT EXISTS quarantines (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES restore_plans(id),
  resource_type TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'quarantined',
  rollback_until_ms INTEGER NOT NULL,
  manual_lock INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quarantines_cleanup_due
  ON quarantines(rollback_until_ms, updated_at_ms)
  WHERE state = 'quarantined' AND manual_lock = 0;
