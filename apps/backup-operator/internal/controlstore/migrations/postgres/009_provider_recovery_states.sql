CREATE TABLE IF NOT EXISTS cnpg_recovery_states (
  plan_id TEXT PRIMARY KEY,
  source_uid TEXT NOT NULL,
  replacement_uid TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL,
  rollback_until_ms BIGINT NOT NULL
);
