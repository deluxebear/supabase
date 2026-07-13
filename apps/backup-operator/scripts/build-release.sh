#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${VERSION:?VERSION is required}"
commit="${COMMIT:?COMMIT is required}"
output="${OUTPUT_DIR:-$root/dist}"
if [[ "$output" != /* ]]; then
  output="$root/$output"
fi
mkdir -p "$output"
rm -f "$output"/backup-operator-* "$output"/backup-agent-* "$output"/backupctl-* "$output"/SHA256SUMS

ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${version} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${commit}"
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go -C "$root" build -trimpath -ldflags="$ldflags" -o "$output/backup-operator-linux-$arch" ./cmd/backup-operator
  cp "$output/backup-operator-linux-$arch" "$output/backup-agent-linux-$arch"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go -C "$root" build -trimpath -ldflags="$ldflags" -o "$output/backupctl-linux-$arch" ./cmd/backupctl
done

(
  cd "$output"
  sha256sum backup-operator-linux-* backup-agent-linux-* backupctl-linux-* > SHA256SUMS
  sha256sum --check SHA256SUMS
)
