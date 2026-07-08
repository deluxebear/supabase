-- [self-platform] M6.4 D3: k8s Pod identity for the container-metrics dialect.
-- Plain, non-secret, PATCH- and panel-editable (mirrors 10-container.sql's
-- container_name). container_name doubles as the k8s container leaf ("postgres").
-- Idempotent; apply manually on upgrade:
--   docker exec -i supabase-platform-db psql -U postgres -d platform < 11-k8s-identity.sql
alter table platform.projects
add column if not exists k8s_namespace text,
add column if not exists k8s_pod_selector text;
