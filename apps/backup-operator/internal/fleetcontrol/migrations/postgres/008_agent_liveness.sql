ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS lease_expires_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS session_unavailable_at_ms BIGINT;

UPDATE agents
SET lease_expires_at_ms = COALESCE(lease_expires_at_ms, last_seen_at_ms + 30000),
    session_unavailable_at_ms = COALESCE(session_unavailable_at_ms, last_seen_at_ms + 60000)
WHERE lease_expires_at_ms IS NULL OR session_unavailable_at_ms IS NULL;

ALTER TABLE agent_capabilities
  ADD COLUMN IF NOT EXISTS valid_until_ms BIGINT;

UPDATE agent_capabilities
SET valid_until_ms = COALESCE(valid_until_ms, observed_at_ms + 30000)
WHERE valid_until_ms IS NULL;

CREATE INDEX IF NOT EXISTS agents_lease_expiry_idx
  ON agents(state, lease_expires_at_ms);
