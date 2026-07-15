CREATE TABLE IF NOT EXISTS operation_event_archive (
  id BIGINT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL,
  archived_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_event_archive (
  id BIGINT PRIMARY KEY,
  actor TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL,
  archived_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS operation_event_archive_operation_idx ON operation_event_archive(operation_id, id);
CREATE INDEX IF NOT EXISTS audit_event_archive_project_idx ON audit_event_archive(project_ref, created_at_ms);
CREATE INDEX IF NOT EXISTS operations_target_state_idx ON operations(target_id, state, created_at_ms);
