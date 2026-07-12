CREATE TABLE IF NOT EXISTS job_event_archive (
  id BIGINT NOT NULL,
  job_id TEXT NOT NULL,
  step_name TEXT,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY(id, created_at_ms)
) PARTITION BY RANGE(created_at_ms);

CREATE TABLE IF NOT EXISTS job_event_archive_default
  PARTITION OF job_event_archive DEFAULT;

CREATE TABLE IF NOT EXISTS audit_event_archive (
  id BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY(id, created_at_ms)
) PARTITION BY RANGE(created_at_ms);

CREATE TABLE IF NOT EXISTS audit_event_archive_default
  PARTITION OF audit_event_archive DEFAULT;
