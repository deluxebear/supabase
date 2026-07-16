ALTER TABLE agents ADD COLUMN lease_expires_at_ms INTEGER;
ALTER TABLE agents ADD COLUMN session_unavailable_at_ms INTEGER;

UPDATE agents
SET lease_expires_at_ms = last_seen_at_ms + 30000,
    session_unavailable_at_ms = last_seen_at_ms + 60000;

ALTER TABLE agent_capabilities ADD COLUMN valid_until_ms INTEGER;

UPDATE agent_capabilities
SET valid_until_ms = observed_at_ms + 30000;

CREATE INDEX IF NOT EXISTS agents_lease_expiry_idx
  ON agents(state, lease_expires_at_ms);
