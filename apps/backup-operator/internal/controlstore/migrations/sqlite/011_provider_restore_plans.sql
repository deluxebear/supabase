CREATE TABLE IF NOT EXISTS provider_restore_plans (
  plan_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (plan_id, provider)
);
