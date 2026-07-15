CREATE TABLE IF NOT EXISTS schema_migrations (
  version BIGINT PRIMARY KEY,
  applied_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_identity (
  singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
  system_identifier TEXT NOT NULL,
  data_domain TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  target_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  capability TEXT NOT NULL,
  state TEXT NOT NULL,
  protocol_major INTEGER NOT NULL,
  protocol_minor INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  expected_generation BIGINT NOT NULL,
  input_schema TEXT NOT NULL,
  typed_input_json JSONB NOT NULL,
  preconditions_json JSONB NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (project_ref, idempotency_key)
);

CREATE TABLE IF NOT EXISTS operation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS fencing_counters (
  domain_key TEXT PRIMARY KEY,
  current_token BIGINT NOT NULL CHECK (current_token > 0)
);

CREATE TABLE IF NOT EXISTS task_fencing_tokens (
  task_id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  UNIQUE (domain_key, fencing_token)
);

CREATE INDEX IF NOT EXISTS idx_operations_project_state ON operations(project_ref, state, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_operation_events_operation ON operation_events(operation_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_project_created ON audit_events(project_ref, created_at_ms);
