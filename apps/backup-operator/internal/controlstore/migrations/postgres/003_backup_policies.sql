CREATE TABLE IF NOT EXISTS backup_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  enabled BOOLEAN NOT NULL,
  backup_type TEXT NOT NULL,
  backup_from TEXT NOT NULL,
  designated_standby TEXT,
  max_standby_lag_bytes BIGINT NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL,
  next_run_at_ms BIGINT NOT NULL,
  claim_owner TEXT,
  claim_until_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_policies_due
  ON backup_policies(next_run_at_ms)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS backup_manifests (
  provider_job_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES backup_policies(id),
  repository_id TEXT NOT NULL,
  backup_label TEXT NOT NULL,
  backup_type TEXT NOT NULL,
  completed_at_ms BIGINT NOT NULL,
  manifest_json JSONB NOT NULL
);
