#!/usr/bin/env bash
set -uo pipefail

scenario="${1:-single-primary-minio}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
evidence_dir="${E2E_EVIDENCE_DIR:-$root/test/e2e/evidence}"
mkdir -p "$evidence_dir"
evidence="$evidence_dir/${scenario}.json"
output="$(mktemp)"
trap 'rm -f "$output"' EXIT

write_status() {
  local status="$1" reason="$2" exit_code="$3"
  jq -n --arg scenario "$scenario" --arg status "$status" --arg reason "$reason" \
    --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson exit_code "$exit_code" \
    '{schema_version:1,scenario:$scenario,status:$status,reason:$reason,exit_code:$exit_code,observed_at:$observed_at}' >"$evidence"
}

for dependency in docker jq; do
  if ! command -v "$dependency" >/dev/null 2>&1; then write_status skipped "missing dependency: $dependency" 0; cat "$evidence"; exit 0; fi
done
if ! docker info >/dev/null 2>&1; then write_status skipped "Docker daemon unavailable" 0; cat "$evidence"; exit 0; fi

case "$scenario" in
  single-primary-minio) command=("$root/test/e2e/single-primary-minio.sh") ;;
  management-policy-walg) command=("$root/test/e2e/management-policy-walg.sh") ;;
  s3-seaweedfs) command=("$root/test/e2e/seaweedfs-s3-contract.sh") ;;
  systemd-recovery) command=("$root/test/e2e/systemd-recovery.sh") ;;
  patroni) command=("$root/spikes/patroni-pitr.sh") ;;
  cloudnativepg)
    for dependency in kind kubectl curl; do
      if ! command -v "$dependency" >/dev/null 2>&1; then write_status skipped "missing dependency: $dependency" 0; cat "$evidence"; exit 0; fi
    done
    command=("$root/test/e2e/cloudnativepg-kind.sh")
    ;;
  kubernetes-pg17|kubernetes-orioledb17)
    for dependency in kind kubectl; do
      if ! command -v "$dependency" >/dev/null 2>&1; then write_status skipped "missing dependency: $dependency" 0; cat "$evidence"; exit 0; fi
    done
    variant="${scenario#kubernetes-}"; command=("$root/test/e2e/kubernetes-kind.sh" "$variant")
    ;;
  kubernetes-negative)
    for dependency in kind kubectl curl; do
      if ! command -v "$dependency" >/dev/null 2>&1; then write_status skipped "missing dependency: $dependency" 0; cat "$evidence"; exit 0; fi
    done
    command=("$root/test/e2e/kubernetes-negative-kind.sh")
    ;;
  *) write_status failed "unknown scenario" 64; cat "$evidence"; exit 64 ;;
esac

(cd "$root" && "${command[@]}") 2>&1 | tee "$output"
exit_code="${PIPESTATUS[0]}"
if [ "$exit_code" -ne 0 ]; then
  reason="scenario command failed"
  if grep -q '^CAPABILITY_BLOCKER=' "$output"; then reason="$(grep '^CAPABILITY_BLOCKER=' "$output" | tail -1 | cut -d= -f2-)"; fi
  status=failed
  case "$exit_code" in 65|69) status=skipped ;; esac
  diagnostics="$(tail -n 200 "$output")"
  jq -n --arg scenario "$scenario" --arg status "$status" --arg reason "$reason" \
    --arg diagnostics "$diagnostics" --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson exit_code "$exit_code" \
    '{schema_version:1,scenario:$scenario,status:$status,reason:$reason,exit_code:$exit_code,observed_at:$observed_at,facts:{diagnostics:$diagnostics}}' >"$evidence"
  cat "$evidence"; exit "$exit_code"
fi

facts="$(awk -F= '/^[A-Za-z0-9_]+=/ {key=$1; sub(/^[^=]*=/, ""); print key "\t" $0}' "$output" \
  | jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}')"
jq -n --arg scenario "$scenario" --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson facts "$facts" \
  '{schema_version:1,scenario:$scenario,status:(if $facts.RESULT=="PASS" then "passed" else "failed" end),exit_code:0,observed_at:$observed_at,facts:$facts}' >"$evidence"
cat "$evidence"
test "$(jq -r .status "$evidence")" = passed
