CREATE TABLE IF NOT EXISTS fencing_counters (
  domain_key TEXT PRIMARY KEY,
  current_token INTEGER NOT NULL CHECK (current_token > 0)
);

CREATE TABLE IF NOT EXISTS task_fencing_tokens (
  task_id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  UNIQUE (domain_key, fencing_token)
);
