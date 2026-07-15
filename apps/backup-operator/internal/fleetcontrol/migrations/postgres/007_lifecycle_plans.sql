CREATE TABLE lifecycle_plans (
  id TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  adapter TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json JSONB NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_operation_id TEXT,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE(project_ref, plan_hash),
  UNIQUE(project_ref, consumed_operation_id)
);
CREATE INDEX lifecycle_plans_project_expiry_idx ON lifecycle_plans(project_ref, expires_at_ms);
