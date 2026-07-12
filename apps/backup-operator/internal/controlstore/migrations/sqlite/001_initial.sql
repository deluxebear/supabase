CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS store_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  system_identifier TEXT NOT NULL,
  data_domain TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  project_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  system_identifier TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, target_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  idempotency_key TEXT,
  plan_hash TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (project_id, target_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS job_steps (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  dispatch_token TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  non_takeover INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  step_name TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_plans (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  plan_hash TEXT NOT NULL UNIQUE,
  safety_input_json TEXT NOT NULL,
  aal2_subject TEXT,
  confirmed_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_enrollments (
  agent_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  certificate_fingerprint TEXT NOT NULL UNIQUE,
  capabilities_json TEXT NOT NULL,
  revoked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_outbox (
  task_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  step_name TEXT NOT NULL,
  capability TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  claim_owner TEXT,
  claim_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS task_results (
  task_id TEXT PRIMARY KEY REFERENCES task_outbox(task_id),
  succeeded INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  error_code TEXT,
  received_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_target_state ON jobs(project_id, target_id, state);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, id);
CREATE INDEX IF NOT EXISTS idx_task_outbox_due ON task_outbox(state, claim_until_ms, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at_ms);
