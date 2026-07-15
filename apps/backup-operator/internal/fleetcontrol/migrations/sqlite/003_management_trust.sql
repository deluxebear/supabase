CREATE TABLE IF NOT EXISTS management_bindings (
  binding_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  target_id TEXT NOT NULL,
  execution_target TEXT NOT NULL,
  deployment_kind TEXT NOT NULL CHECK (deployment_kind IN ('compose', 'kubernetes', 'systemd', 'bare-metal')),
  allowed_capability_prefixes_json TEXT NOT NULL CHECK (json_valid(allowed_capability_prefixes_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'enrolling', 'active', 'revoked', 'incompatible')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (project_ref, binding_id)
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  binding_id TEXT NOT NULL REFERENCES management_bindings(binding_id),
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  revoked_at_ms INTEGER,
  created_by TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES management_bindings(binding_id),
  state TEXT NOT NULL CHECK (state IN ('online', 'offline', 'revoked', 'replaced', 'incompatible')),
  protocol_major INTEGER NOT NULL,
  protocol_minor INTEGER NOT NULL,
  build TEXT NOT NULL,
  observed_identity_json TEXT NOT NULL CHECK (json_valid(observed_identity_json)),
  active_certificate_revision INTEGER NOT NULL CHECK (active_certificate_revision > 0),
  last_seen_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_one_active_per_binding_idx
  ON agents(binding_id) WHERE state IN ('online', 'offline', 'incompatible');

CREATE TABLE IF NOT EXISTS agent_certificates (
  serial TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  fingerprint TEXT NOT NULL UNIQUE CHECK (length(fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('active', 'overlap', 'revoked', 'replaced', 'expired')),
  not_before_ms INTEGER NOT NULL,
  not_after_ms INTEGER NOT NULL,
  overlap_until_ms INTEGER,
  issued_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  UNIQUE (agent_id, revision)
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  evidence_schema TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_id, name)
);

CREATE INDEX IF NOT EXISTS enrollment_tokens_binding_idx ON enrollment_tokens(binding_id, expires_at_ms);
CREATE INDEX IF NOT EXISTS agent_certificates_agent_idx ON agent_certificates(agent_id, revision);
CREATE INDEX IF NOT EXISTS agent_capabilities_agent_idx ON agent_capabilities(agent_id, domain, name);
