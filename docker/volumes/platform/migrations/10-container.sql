-- M6.4: per-project Postgres container identity for container-granular infra
-- metrics. NULL = no container registered → the sampler reads host-level
-- metrics (M6.3 fallback). When set (e.g. 'supabase-db'), the adapter reads
-- cAdvisor container_* series filtered by name=<container_name>, giving
-- per-project CPU/RAM/network even on shared stacks. Plaintext (a container
-- name, not a secret), nullable, PATCH- and panel-editable — mirrors
-- metrics_url. Idempotent (add column if not exists).
alter table platform.projects add column if not exists container_name text;
