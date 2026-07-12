CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  encrypted_credentials BYTEA NOT NULL,
  key_id TEXT NOT NULL,
  credential_generation BIGINT NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stanza_bindings (
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  stanza TEXT NOT NULL,
  system_identifier TEXT NOT NULL,
  postgres_major INTEGER NOT NULL,
  database_history_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (repository_id, stanza)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stanza_history
  ON stanza_bindings(repository_id, system_identifier, database_history_id);
