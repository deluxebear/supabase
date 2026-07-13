CREATE TABLE IF NOT EXISTS kubernetes_recovery_states (
  plan_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  stable_service_resource_version TEXT NOT NULL DEFAULT '',
  old_statefulset_resource_version TEXT NOT NULL DEFAULT '',
  old_pvc_uids_json JSONB NOT NULL,
  cleanup_after_ms BIGINT NOT NULL DEFAULT 0
);
