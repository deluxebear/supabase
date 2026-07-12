#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

./scripts/generate-contracts.sh
git diff --exit-code -- gen/openapi/v1 gen/proto/v1
