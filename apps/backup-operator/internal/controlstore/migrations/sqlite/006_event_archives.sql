CREATE TABLE IF NOT EXISTS job_event_archive (
  id INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  step_name TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(id, created_at_ms)
);

CREATE TABLE IF NOT EXISTS audit_event_archive (
  id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(id, created_at_ms)
);
