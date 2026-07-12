#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.4.1 \
  -generate types \
  -package openapiv1 \
  -o gen/openapi/v1/types.gen.go \
  api/openapi/v1/openapi.yaml

go run github.com/bufbuild/buf/cmd/buf@v1.50.0 generate
gofmt -w gen/openapi/v1 gen/proto/v1
