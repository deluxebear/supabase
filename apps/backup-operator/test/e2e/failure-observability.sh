#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
evidence="$root/test/e2e/evidence/failure-observability.json"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$root"

# One immutable identity is attached to every matrix result. This prevents
# mixing crash evidence produced by different source trees or binaries.
matrix_version="ifn-failure-matrix"
matrix_commit="$(git -C "$root" rev-parse HEAD)"
matrix_ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${matrix_version} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${matrix_commit}"
CGO_ENABLED=0 go build -trimpath -ldflags="$matrix_ldflags" -o "$tmp/backup-operator" ./cmd/backup-operator
matrix_sha256="$(sha256sum "$tmp/backup-operator" | awk '{print $1}')"
test "$("$tmp/backup-operator" --version)" = "${matrix_version}+${matrix_commit}"

go test ./internal/recoveryexec ./internal/agentjournal ./internal/orchestration ./internal/hardening ./internal/writefence \
  -run 'Test(CrashAfterEveryRecoverySideEffect|CrashAfterRestoreSideEffect|UncertainPostcondition|FailureClassificationMatrix|InjectedRecoveryFailures|FailureInjectionBeforeAndDuringRestore|ArchiveCheckFailure|Orphan|Runtime|Provider)' \
  -count=1 | tee "$tmp/failure.log"
go test -race ./internal/api ./internal/controlstore ./internal/observability ./internal/orchestration ./internal/app -count=1 | tee "$tmp/observability.log"

if command -v promtool >/dev/null 2>&1; then
  promtool check rules deploy/monitoring/alerts.yaml | tee "$tmp/alerts.log"
  alert_runtime=host
else
  docker run --rm --entrypoint promtool -v "$root/deploy/monitoring:/monitoring:ro" prom/prometheus:v3.5.0 \
    check rules /monitoring/alerts.yaml | tee "$tmp/alerts.log"
  alert_runtime=container
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify deploy/systemd/backup-operator.service deploy/systemd/backup-agent.service \
    2> >(grep -v 'Command .* is not executable' >&2 || true) | tee "$tmp/systemd.log"
  systemd_runtime=linux-host
else
  timeout 240 docker run --rm -v "$root/deploy/systemd:/units:ro" postgres:17-bookworm bash -ec '
    apt-get update -qq
    apt-get install -y -qq systemd >/dev/null
    mkdir -p /usr/local/bin /etc/backup-operator /var/lib/backup-operator /var/lib/backup-agent /var/lib/postgresql /etc/pgbackrest
    touch /usr/local/bin/backup-operator /etc/backup-operator/operator.env /etc/backup-operator/agent.env
    chmod +x /usr/local/bin/backup-operator
    systemd-analyze verify /units/backup-operator.service /units/backup-agent.service
  ' 2>&1 | tee "$tmp/systemd.log"
  systemd_runtime=postgres17-bookworm-container
fi

for route in \
  'POST /v1/operations' \
  'POST /v1/operations/{operationId}/cancel' \
  'POST /v1/operations/{operationId}/retry' \
  'PUT /v1/clusters/{clusterId}/backup-policy' \
  'POST /v1/clusters/{clusterId}/restore-plans' \
  'POST /v1/clusters/{clusterId}/restore-plans/{planId}/confirm' \
  'POST /v1/clusters/{clusterId}/restore-plans/{planId}/execute' \
  'POST /v1/clusters/{clusterId}/jobs/{jobId}/rollback'; do
  rg -F "mux.HandleFunc(\"$route\", mutation(" internal/api/handler.go >/dev/null
done

for reused in \
  test/e2e/evidence/s3-seaweedfs.json \
  test/e2e/evidence/systemd-recovery.json \
  test/e2e/evidence/kubernetes-negative.json; do
  test "$(jq -r .status "$reused")" = passed
done

jq -n \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg alert_runtime "$alert_runtime" --arg systemd_runtime "$systemd_runtime" \
  --arg matrix_version "$matrix_version" --arg matrix_commit "$matrix_commit" --arg matrix_sha256 "$matrix_sha256" \
  --arg single_primary "$(jq -r .status test/e2e/evidence/single-primary-minio.json)" \
  --arg cnpg "$(jq -r .status test/e2e/evidence/cloudnativepg.json)" \
  --arg kubernetes_pg17 "$(jq -r .status test/e2e/evidence/kubernetes-pg17.json)" \
  --arg kubernetes_orioledb17 "$(jq -r .status test/e2e/evidence/kubernetes-orioledb17.json)" \
  --arg patroni "$(jq -r .result test/evidence/patroni-name-round15.json | tr '[:upper:]' '[:lower:]')" \
  --arg seaweedfs "$(jq -r .status test/e2e/evidence/s3-seaweedfs.json)" \
  --arg systemd_recovery "$(jq -r .status test/e2e/evidence/systemd-recovery.json)" \
  --arg kubernetes_negative "$(jq -r .status test/e2e/evidence/kubernetes-negative.json)" \
  --argjson classifications '[
    {"scenario":"wal-gap","class":"manual","code":"wal_gap","safe_action":"Keep PostgreSQL stopped and choose a target inside verified continuous WAL coverage","runbook":"production-runbook#wal-gap-or-stale-evidence"},
    {"scenario":"wrong-system-id-or-stanza","class":"manual","code":"system_id_or_stanza_mismatch","safe_action":"Preserve both data directories and correct the enrolled repository identity","runbook":"production-runbook#identity-mismatch"},
    {"scenario":"disk-full","class":"manual","code":"insufficient_capacity","safe_action":"Keep repository writes disabled and add capacity before creating a new plan","runbook":"production-runbook#capacity-or-disk-full"},
    {"scenario":"s3-outage","class":"retryable","code":"repository_unavailable","safe_action":"Keep repository read-only and retry only after the enrolled endpoint is healthy","runbook":"production-runbook#repository-unavailable-or-throttled"},
    {"scenario":"s3-throttle","class":"retryable","code":"repository_unavailable","safe_action":"Keep repository read-only and retry with bounded backoff","runbook":"production-runbook#repository-unavailable-or-throttled"},
    {"scenario":"agent-crash","class":"orphan","code":"postcondition_uncertain","safe_action":"Inspect the node-local journal and reconcile the original task without takeover","runbook":"production-runbook#orphaned-destructive-task"},
    {"scenario":"operator-crash","class":"orphan","code":"postcondition_uncertain","safe_action":"Reconcile durable outbox, Agent result, and step postcondition before continuing","runbook":"production-runbook#orphaned-destructive-task"},
    {"scenario":"lease-expiry","class":"orphan","code":"postcondition_uncertain","safe_action":"Do not transfer the task; reconcile the original Agent result","runbook":"production-runbook#lease-expiry"},
    {"scenario":"archive-pollution","class":"compensating","code":"archive_failure","safe_action":"Disable repository writes and preserve both timeline histories","runbook":"production-runbook#archive-pollution"},
    {"scenario":"cutover-response-loss","class":"orphan","code":"cutover_failure","safe_action":"Read the stable route identity before retrying or rolling back","runbook":"production-runbook#cutover-response-loss"},
    {"scenario":"fence-release-failure","class":"manual","code":"fence_release_failure","safe_action":"Re-block every writer path and retry release with the original fence handle","runbook":"production-runbook#write-fence-release-failure"}
  ]' \
  '{schema_version:1,scenario:"failure-observability-matrix",status:"passed",exit_code:0,observed_at:$observed_at,
    facts:{
      build_identity:{version:$matrix_version,commit:$matrix_commit,binary_sha256:$matrix_sha256},
      failure_matrix:"passed: every internal recovery side effect crash/orphan reconciliation plus real systemd Operator SIGKILL at postgres-stopped, original-quarantined, restored, and cut-over; disk full, S3 outage/throttle, archive failure, fail-closed fence release, cutover response loss, manual classification",
      classifications:$classifications,
      preservation:"original PGDATA, failed recovery PGDATA, and repository history remain retained for every destructive failure",
      systemd_validation:("passed:"+$systemd_runtime),
      metrics_validation:"passed: app GET /metrics plus low-cardinality jobs/duration/agent/outbox/orphan/repository/WAL/window/quarantine families",
      mutation_audit:"passed: every registered mutation is audited; 1000-record export and bounded archive-before-delete retention preserve content and cursor order",
      race_backpressure:"passed: race-enabled app/orchestration/controlstore/observability/API suite and bounded Agent queue drop accounting",
      alert_rules:("passed:promtool:"+$alert_runtime),
      reused_happy_path_evidence:{single_primary_minio:$single_primary,cloudnativepg:$cnpg,kubernetes_pg17:$kubernetes_pg17,kubernetes_orioledb17:$kubernetes_orioledb17,patroni:$patroni,seaweedfs_s3:$seaweedfs,systemd_recovery:$systemd_recovery,kubernetes_negative:$kubernetes_negative},
      happy_paths_rerun:false,
      RESULT:"PASS"
    }}' >"$evidence"
cat "$evidence"
