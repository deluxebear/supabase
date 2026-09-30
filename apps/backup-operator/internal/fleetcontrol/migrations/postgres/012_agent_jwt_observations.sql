CREATE TABLE IF NOT EXISTS agent_jwt_observations (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id),
 observation_json TEXT NOT NULL,
 observed_at_ms BIGINT NOT NULL
);
