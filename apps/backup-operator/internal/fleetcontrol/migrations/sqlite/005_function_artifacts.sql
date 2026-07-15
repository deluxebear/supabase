CREATE TABLE IF NOT EXISTS function_artifacts (
  project_ref TEXT NOT NULL,
  digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 20971520),
  created_by TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project_ref, digest)
);

CREATE INDEX IF NOT EXISTS function_artifacts_created_idx
  ON function_artifacts(project_ref, created_at_ms DESC);
