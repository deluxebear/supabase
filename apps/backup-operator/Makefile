.PHONY: build test generate check-generated release-snapshot validate-deployments

build:
	go build ./cmd/backup-operator ./cmd/backupctl ./cmd/fleet-control ./cmd/fleet-agent ./cmd/fleet-agent-bootstrap

test:
	go test ./...

generate:
	./scripts/generate-contracts.sh

check-generated:
	./scripts/check-generated.sh

release-snapshot:
	VERSION=$${VERSION:-dev} COMMIT=$${COMMIT:-$$(git rev-parse HEAD)} ./scripts/build-release.sh

validate-deployments:
	./scripts/validate-deployments.sh
