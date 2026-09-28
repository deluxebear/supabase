-- Each Agent's X25519 public key for sealed secrets. Studio seals secret
-- material to this key, so Fleet Control stores and relays only ciphertext.
-- The Agent reports the key in every hello; the private key never leaves it.
CREATE TABLE IF NOT EXISTS agent_secret_recipients (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  public_key TEXT NOT NULL CHECK (length(public_key) = 44),
  key_id TEXT NOT NULL CHECK (length(key_id) = 32),
  updated_at_ms BIGINT NOT NULL
);
