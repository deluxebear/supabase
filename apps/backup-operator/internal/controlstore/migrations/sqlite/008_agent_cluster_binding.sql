ALTER TABLE agent_enrollments ADD COLUMN cluster_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_enrollment_cluster_node ON agent_enrollments(cluster_id, node_id);
