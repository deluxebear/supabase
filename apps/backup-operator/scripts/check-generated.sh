#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

before="$(mktemp -d)"
trap 'rm -rf "$before"' EXIT
cp -R gen/openapi/v1 "$before/openapi"
cp -R gen/proto/v1 "$before/proto"
cp -R gen/openapi/fleet/v1 "$before/fleet-openapi"
cp -R gen/proto/agent "$before/agent-proto"
cp -R gen/proto/fleet "$before/fleet-proto"
./scripts/generate-contracts.sh
diff -ru "$before/openapi" gen/openapi/v1
diff -ru "$before/proto" gen/proto/v1
diff -ru "$before/fleet-openapi" gen/openapi/fleet/v1
diff -ru "$before/agent-proto" gen/proto/agent
diff -ru "$before/fleet-proto" gen/proto/fleet
