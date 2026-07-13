#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

before="$(mktemp -d)"
trap 'rm -rf "$before"' EXIT
cp -R gen/openapi/v1 "$before/openapi"
cp -R gen/proto/v1 "$before/proto"
./scripts/generate-contracts.sh
diff -ru "$before/openapi" gen/openapi/v1
diff -ru "$before/proto" gen/proto/v1
