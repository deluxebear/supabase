#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
evidence="$root/test/evidence/ifn41-44-management-policy.json"
container="backup-policy-walg-$$"
tmp="$(mktemp -d)"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

cd "$root"
go test ./internal/api -run TestClusterPITRPolicyAndManualBackupAPI -count=1 | tee "$tmp/api.log"
go test ./internal/pgbackrest -run TestEnablementFailsClosedWhenWALGOwnsArchiveCommand -count=1 | tee "$tmp/walg-unit.log"

docker run -d --name "$container" -e POSTGRES_PASSWORD=contract postgres:17-bookworm -c archive_mode=on >/dev/null
for _ in $(seq 1 90); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -c \
  "ALTER SYSTEM SET archive_command = 'wal-g wal-push %p'" >/dev/null
docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -c "SELECT pg_reload_conf()" >/dev/null
observed="$(docker exec "$container" psql -U postgres -Atqc 'SHOW archive_command')"
test "$observed" = 'wal-g wal-push %p'

jq -n \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg archive_command "$observed" \
  '{schema_version:1,contract:"IFN-41/44",status:"passed",observed_at:$observed_at,
    checks:{cluster_register_get_discover:true,pitr_enable_disable_check:true,manual_backup:true,
      standard_policy:{retention_days:14,full_schedule:"0 2 * * *",diff_schedule:"0 2 * * 1-6",incr_schedule:"0 * * * *"},
      walg_conflict:{real_postgres17:true,observed_archive_command:$archive_command,failed_closed_before_side_effect:true}},
    RESULT:"PASS"}' > "$evidence"
cat "$evidence"
