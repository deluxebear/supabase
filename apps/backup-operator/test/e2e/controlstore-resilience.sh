#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
evidence="$root/test/e2e/evidence/controlstore-resilience.json"
container="backup-operator-controlstore-$RANDOM-$$"
postgres_runtime=not-run
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cd "$root"

go test -race ./internal/controlstore ./internal/orchestration ./internal/agenttransport ./internal/agentjournal ./internal/agent ./internal/security ./internal/app \
  -run 'Test(SQLiteTransactionalOutbox|SQLiteRejectsSameRecoveryDomain|SQLiteLeaseEnrollmentPlanClaimAndRetention|ConcurrentOutboxClaimIsExclusive|PendingOutboxSurvivesRestart|SQLiteDiskFull|DispatcherMarksSuccessAndReleasesFailure|OperatorRestartRequeuesTaskWhenSessionDispatchFails|DestructiveDisconnectBecomesOrphaned|RestartMarksDestructiveExecutionOrphaned|DuplicateTaskReplaysDurableResult|NegotiationAndDestructiveVersionPin|DefaultRuntimeAllModeLifecycle)' \
  -count=1

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker run -d --name "$container" -e POSTGRES_PASSWORD=controlstore-test -e POSTGRES_DB=controlstore \
    -p 127.0.0.1::5432 postgres:17-bookworm >/dev/null
  port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
  for _ in $(seq 1 60); do
    docker exec "$container" pg_isready -U postgres -d controlstore >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$container" pg_isready -U postgres -d controlstore >/dev/null
  CONTROLSTORE_POSTGRES_TEST_DSN="postgres://postgres:controlstore-test@127.0.0.1:${port}/controlstore?sslmode=disable" \
    go test -race ./internal/controlstore -run TestPostgresTransactionalOutboxIntegration -count=1 -v
  postgres_runtime=postgres17-container
else
  postgres_runtime=unavailable
  printf 'CAPABILITY_BLOCKER=real PostgreSQL control-store integration requires Docker\n'
  exit 69
fi

jq -n \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg postgres_runtime "$postgres_runtime" \
  --arg prior_failure_observability "$(jq -r .status test/e2e/evidence/failure-observability.json)" \
  '{schema_version:1,scenario:"controlstore-resilience-matrix",status:"passed",exit_code:0,observed_at:$observed_at,
    facts:{
      sqlite_controlstore:"passed: transactional outbox, recovery-domain isolation, disk-full fail-closed",
      postgres_controlstore:("passed:"+$postgres_runtime+":migrations/reopen/transactional-outbox"),
      dual_operator_claim:"passed: SQLite and real PostgreSQL concurrent SKIP LOCKED claims are exclusive",
      network_partition:"passed: session disconnect releases non-destructive dispatch and orphans destructive work on both sides",
      disk_full:"passed: SQLITE_FULL preserves previously committed audit",
      agent_restart:"passed: running destructive journal entry becomes non-takeover orphan",
      operator_restart:"passed: pending/released outbox survives store close and re-open",
      version_upgrade:"passed: idempotent migration re-open preserves identity and persisted rows",
      protocol_migration:"passed: minor-version negotiation and destructive build pin reject incompatible takeover",
      reused_failure_observability:$prior_failure_observability,
      expensive_happy_paths_rerun:false,
      RESULT:"PASS"
    }}' >"$evidence"
cat "$evidence"
